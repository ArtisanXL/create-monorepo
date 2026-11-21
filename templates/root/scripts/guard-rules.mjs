// The guard hook's decision, free of I/O: no stdin, env, filesystem or exit. The first matching
// rule wins, so each message stays the same as it always was. Imported by .claude/hooks/guard.mjs.
import path from "node:path";
import {
  claudeBlockSpan,
  deferredDepInCommand,
  deferredHint,
  isProtected,
  isProtectedOrDir,
  packageOf,
} from "./arch-contract.mjs";

const toPosix = (p) => p.split(path.sep).join("/");

// darwin and win32 filesystems are case-insensitive by default: fold the contract and every path
// to lower case there. The platform is injected (see decide) so this module stays pure.
const CASE_INSENSITIVE = new Set(["darwin", "win32"]);
const lower = (s) => s.toLowerCase();
const foldContract = (c) => ({
  ...c,
  protectedPaths: c.protectedPaths.map(lower),
  exceptions: c.exceptions.map(lower),
  packages: Object.fromEntries(Object.entries(c.packages).map(([k, v]) => [lower(k), v])),
  deferred: c.deferred.map((d) => (d.path ? { ...d, path: lower(d.path) } : d)),
});

/** A folder that contains protected paths (`docs` for `docs/adr/`); deleting or moving it destroys them. */
const holdsProtected = (contract, rel) => rel !== "" && contract.protectedPaths.some((p) => p.startsWith(`${rel}/`));

function pathRule(contract, r) {
  if (r.startsWith("..") || path.isAbsolute(r)) return undefined;
  if (isProtected(contract, r))
    return `${r} is protected; only humans may change it. If a change is needed, write an ADR draft under docs/adr/proposed/ and ask the user.`;
  const owner = packageOf(contract, r);
  if (owner && !owner.declared)
    return `${owner.dir} is not a package declared in architecture.json. ${owner.deferred ? deferredHint(owner.deferred) : "Adding a package requires an accepted ADR."}`;
  return undefined;
}

/** CLAUDE.md: edits touching the scaffold block are blocked; outside the block is free. */
function claudeMdRule(contract, tool, ti, text) {
  if (!contract.claudeBlock || text === undefined) return undefined;
  const span = claudeBlockSpan(text, contract.claudeBlock);
  if (!span) return undefined;
  const { start: b, end } = span;
  const msg = "The scaffold block in CLAUDE.md is protected; edit only outside the block.";
  // A second begin marker would make a decoy block the real first-marker span, so adding one is blocked.
  const begins = (s) => s.split(contract.claudeBlock.begin).length - 1;
  if (tool === "Write") {
    const content = String(ti.content ?? "");
    if (!content.includes(text.slice(b, end))) return msg;
    return begins(content) > Math.max(1, begins(text)) ? msg : undefined;
  }
  const edits = tool === "MultiEdit" ? (ti.edits ?? []) : [ti];
  if (edits.some((ed) => String(ed.new_string ?? "").includes(contract.claudeBlock.begin))) return msg;
  // Checked on the file's own text and on its LF form, so an LF old_string cannot slip past a CRLF file.
  const lf = text.replace(/\r\n/g, "\n");
  const lfSpan = claudeBlockSpan(lf, contract.claudeBlock);
  const touches = (haystack, old, from, to) => {
    for (let i = haystack.indexOf(old); i >= 0; i = haystack.indexOf(old, i + 1))
      if (i < to && i + old.length > from) return true;
    return false;
  };
  for (const ed of edits) {
    const old = String(ed.old_string ?? "");
    if (!old) continue;
    if (touches(text, old, b, end)) return msg;
    if (lfSpan && touches(lf, old.replace(/\r\n/g, "\n"), lfSpan.start, lfSpan.end)) return msg;
  }
  return undefined;
}

function fileRule({ contract, root, f }, tool, ti, claudeMdText) {
  const fp = ti.file_path ?? ti.notebook_path;
  if (!fp) return undefined;
  const r = toPosix(path.relative(root, path.resolve(root, f(fp))));
  return pathRule(contract, r) ?? (r === f("CLAUDE.md") ? claudeMdRule(contract, tool, ti, claudeMdText) : undefined);
}

const SHELL_STRING =
  /\b(?:(?:(?:ba|z|da|k)?sh\s+(?:-\S+\s+)*?-[A-Za-z]*c)|eval)\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/g;
const WRAPPERS = new Set(["sudo", "time", "env", "command", "exec", "nohup", "nice", "corepack", "npx", "xargs", "builtin"]);
const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "{", "}"]);
const ASSIGNMENT = /^[A-Za-z_]\w*=/;
const WRITERS = new Set(["mkdir", "touch", "cp", "mv", "rm", "tee", "truncate", "ln", "install"]);
const INTERPRETERS = /^(?:node|nodejs|bun|deno|python[\d.]*|perl|ruby|php|tsx|ts-node)$/;
const EVAL_FLAG = /^(?:-[A-Za-z]*[ecEp]|--eval(?:=.*)?|--print(?:=.*)?)$/;
const baseName = (w) => w.replace(/^.*[\\/]/, "");

/**
 * Splits a shell command into simple commands: quotes are removed, `;` `&&` `||` `|` `&` newlines,
 * parentheses and backticks separate commands, and redirects (`>`, `>>`, `>|`, `>&file`, `&>`) are
 * collected apart from the words. Heredoc bodies are not understood (their lines parse as commands).
 */
function shellSegments(cmd) {
  const segments = [];
  let words = [];
  let redirs = [];
  let cur = null;
  let pending = null;
  const pushWord = () => {
    if (cur === null) return;
    const w = cur;
    cur = null;
    if (pending) {
      const p = pending;
      pending = null;
      if (p.op === "<" || (p.amp && /^(\d+|-)$/.test(w.text))) return;
      redirs.push({ op: p.op, target: w.text });
    } else words.push(w);
  };
  const end = () => {
    pushWord();
    pending = null;
    if (words.length || redirs.length) segments.push({ words, redirs });
    words = [];
    redirs = [];
  };
  const grow = () => {
    cur ??= { text: "", quoted: false };
    return cur;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "\\") {
      if (cmd[i + 1] === "\n") i++;
      else if (i + 1 < cmd.length) grow().text += cmd[++i];
    } else if (c === "'") {
      const e = cmd.indexOf("'", i + 1);
      const stop = e < 0 ? cmd.length : e;
      grow().quoted = true;
      cur.text += cmd.slice(i + 1, stop);
      i = stop;
    } else if (c === '"') {
      grow().quoted = true;
      for (i++; i < cmd.length && cmd[i] !== '"'; i++) {
        if (cmd[i] === "\\" && '"\\$`'.includes(cmd[i + 1] ?? "")) i++;
        cur.text += cmd[i];
      }
    } else if (c === " " || c === "\t" || c === "\r") pushWord();
    else if (c === "\n" || c === ";" || c === "(" || c === ")" || c === "`" || c === "|") {
      end();
      if (c === "|" && cmd[i + 1] === "|") i++;
    } else if (c === "&" && cmd[i + 1] !== ">") {
      end();
      if (cmd[i + 1] === "&") i++;
    } else if (c === ">" || c === "<" || c === "&") {
      if (cur !== null && !cur.quoted && /^\d+$/.test(cur.text)) cur = null;
      else pushWord();
      if (c === "&") i++;
      let op = c === "<" ? "<" : ">";
      let amp = false;
      if (c === "<") while (cmd[i + 1] === "<") i++;
      else if (cmd[i + 1] === ">") {
        op = ">>";
        i++;
      } else if (cmd[i + 1] === "|") i++;
      else if (cmd[i + 1] === "&") {
        amp = true;
        i++;
      }
      pending = { op, amp };
    } else grow().text += c;
  }
  end();
  return segments;
}

/** Drops assignments, keywords and wrapper prefixes (and their flags); `find -exec` yields its inner command too. */
function commandsOf(words) {
  let i = 0;
  while (i < words.length) {
    const w = words[i].text;
    if (ASSIGNMENT.test(w) || KEYWORDS.has(w)) i++;
    else if (WRAPPERS.has(baseName(w))) {
      i++;
      while (i < words.length && words[i].text.startsWith("-")) i++;
    } else break;
  }
  if (i >= words.length) return [];
  const name = baseName(words[i].text);
  const args = words.slice(i + 1);
  const out = [{ name, args }];
  if (name === "find") {
    const k = args.findIndex((a) => /^-(?:exec|execdir|ok|okdir)$/.test(a.text));
    if (k >= 0) out.push(...commandsOf(args.slice(k + 1)));
  }
  return out;
}

/** Splits arguments into flags and operands; everything after `--` is an operand. */
function splitArgs(args) {
  const flags = [];
  const operands = [];
  let rest = false;
  for (const a of args) {
    if (!rest && a.text === "--") rest = true;
    else if (!rest && a.text.length > 1 && a.text.startsWith("-")) flags.push(a.text);
    else operands.push(a);
  }
  return { flags, operands };
}

/**
 * The commands and redirects of a shell command line, each with the directories it may run in.
 * `bases` are absolute: the project root plus every directory a preceding `cd` / `pushd` may have
 * led to (each resolved against all earlier ones, so chains are followed; the root stays in because
 * a `cd` can fail). `tight` is only the directories after the latest `cd`.
 */
export function targetsOf(cmd, root, expand) {
  const commands = [];
  const redirects = [];
  let bases = [root];
  let tight = [root];
  for (const seg of shellSegments(cmd)) {
    for (const r of seg.redirs) redirects.push({ op: r.op, target: r.target, bases });
    for (const c of commandsOf(seg.words)) {
      commands.push({ ...c, bases, tight });
      if (c.name === "cd" || c.name === "pushd") {
        const dir = splitArgs(c.args).operands[0];
        if (dir && dir.text !== "-") {
          const next = bases.map((b) => path.resolve(b, expand(dir.text)));
          tight = [...new Set(next)];
          bases = [...new Set([...bases, ...next])];
        }
      }
    }
  }
  return { commands, redirects };
}

function directRule({ contract, root, home, f }, cmd) {
  const expand = (t) => f(t.replace(/^~(?=\/)/, home));
  const { commands, redirects } = targetsOf(cmd, root, expand);
  // Root-relative paths of the words, against each base; paths outside the project are ignored.
  const relsOf = (words, bases, keepRoot = false) =>
    words.flatMap((w) =>
      bases.flatMap((b) => {
        const r = toPosix(path.relative(root, path.resolve(b, expand(typeof w === "string" ? w : w.text))));
        return (keepRoot || r) && !r.startsWith("..") && !path.isAbsolute(r) ? [r] : [];
      }),
    );
  const touchesProtectedPath = (r) => isProtectedOrDir(contract, r);
  const claudeMd = f("CLAUDE.md");
  const claudeMsg = "CLAUDE.md must not be modified via Bash; use the Edit tool, outside the scaffold block only.";
  const protectedMsg = "Command touches a protected path; only humans may change it.";
  const gitMsg = "Command touches a protected path via git; only humans may change it.";
  const folderMsg = "Command would delete or move a folder that contains protected paths; only humans may change them.";
  const oneLinerMsg = "Command touches a protected path through an interpreter one-liner; only humans may change it.";

  const writeRels = [];
  for (const r of redirects) {
    const rels = relsOf([r.target], r.bases);
    if (r.op === ">" && rels.includes(claudeMd)) return claudeMsg;
    writeRels.push(...rels);
  }

  for (const c of commands) {
    const { flags: fl, operands } = splitArgs(c.args);
    const rels = relsOf(operands, c.bases);
    const isWriter =
      WRITERS.has(c.name) ||
      (c.name === "sed" && fl.some((x) => /^-[A-Za-z]*i|^--in-place/.test(x))) ||
      (c.name === "perl" && fl.some((x) => /^-[A-Za-z]*i/.test(x)));
    if (isWriter) {
      const appends = fl.some((x) => /^-[A-Za-z]*a|^--append/.test(x));
      if (rels.includes(claudeMd) && (["rm", "mv", "cp", "truncate", "sed", "perl"].includes(c.name) || (c.name === "tee" && !appends)))
        return claudeMsg;
      writeRels.push(...rels);
    }
    if (c.name === "dd")
      for (const a of c.args) if (a.text.startsWith("of=")) writeRels.push(...relsOf([a.text.slice(3)], c.bases));

    if (c.name === "git") {
      let i = 0;
      const dirs = [];
      for (; i < c.args.length; i++) {
        const t = c.args[i].text;
        if (t === "-C" || t === "-c" || /^--(?:git-dir|work-tree|namespace)$/.test(t)) {
          if (t === "-C" && c.args[i + 1]) dirs.push(c.args[i + 1].text);
          i++;
        } else if (!t.startsWith("-")) break;
      }
      const sub = c.args[i]?.text;
      if (["clean", "checkout", "restore", "rm", "mv"].includes(sub ?? "")) {
        const gb = [...c.bases, ...c.bases.flatMap((b) => dirs.map((d) => path.resolve(b, expand(d))))];
        const g = splitArgs(c.args.slice(i + 1));
        const grels = relsOf(g.operands, gb);
        if (grels.some((r) => touchesProtectedPath(r) || holdsProtected(contract, r))) return gitMsg;
        // A whole-tree revert from a revision rewrites protected files too: `checkout <rev> -- .`, `restore --source=<rev> .`.
        const dots = g.operands.filter((o) => o.text === "." || o.text === "./" || o.text === ":/");
        if (dots.length && ((sub === "checkout" && g.operands.length > dots.length) || (sub === "restore" && g.flags.some((x) => /^(?:--source|-s)/.test(x)))))
          return gitMsg;
      }
    }

    if (c.name === "rm" || c.name === "mv") {
      const byTarget = fl.some((x) => /^--target-directory|^-[A-Za-z]*t$/.test(x));
      const sources = c.name === "rm" || byTarget ? operands : operands.slice(0, -1);
      // `rm -rf .` empties the project only when no `cd` moved elsewhere first.
      if (
        relsOf(sources, c.bases).some((r) => holdsProtected(contract, r)) ||
        (c.name === "rm" && relsOf(sources, c.tight, true).includes(""))
      )
        return folderMsg;
    }

    // Interpreter one-liners hide the write inside a string; blocked when they mention a protected path
    // (a protected file, or a protected folder written as `folder/` or as a quoted literal).
    // Read-only one-liners that mention one are blocked too: a read cannot be told from a write.
    if (INTERPRETERS.test(c.name)) {
      let code;
      if (c.name === "deno" && c.args[0]?.text === "eval") code = c.args.slice(1);
      else
        for (let i = 0; i < c.args.length; i++) {
          const t = c.args[i].text;
          if (!t.startsWith("-")) break;
          if (EVAL_FLAG.test(t)) {
            code = c.args.slice(i + 1);
            break;
          }
          if (/^--?(?:r|require|import|loader|experimental-loader)$/.test(t)) i++;
        }
      if (code) {
        for (const w of code)
          for (const m of w.text.matchAll(/[^\s"'`<>|;&()]+/g)) {
            const t = m[0];
            const pathLike = t.endsWith("/") || ["'", '"', "`"].some((q) => w.text.includes(q + t + q));
            for (const r of relsOf([t], c.bases))
              if (isProtected(contract, r) || (pathLike && (touchesProtectedPath(r) || holdsProtected(contract, r))))
                return oneLinerMsg;
          }
      }
    }
  }
  if (/--no-verify\b/.test(cmd) || /\bgit\s+commit\b[^|;&]*\s-n\b/.test(cmd))
    return "Skipping git hooks is forbidden (--no-verify).";
  if (/core\.hooksPath/.test(cmd) && !/\.githooks/.test(cmd)) return "Changing the git hooks path is forbidden.";
  // pm-guard:begin
  const chosenPm = contract.packageManager;
  if (chosenPm) {
    // Optional command prefixes: sudo/time/env/corepack..., their flags and VAR=value assignments.
    const wrappers =
      "(?:(?:sudo|time|env|command|exec|nohup|nice|corepack)\\s+|-\\S+\\s+|[A-Za-z_]\\w*=\\S*\\s+)*";
    for (const pm of ["pnpm", "npm", "yarn", "bun"].filter((x) => x !== chosenPm)) {
      const install = new RegExp(
        `(^|[;&|(])\\s*${wrappers}${pm}(\\s*($|[;&|)])|\\s+(install|i|add|ci|update|up|upgrade)\\b)`,
      );
      if (cmd.split("\n").some((l) => install.test(l)))
        return `This project uses ${chosenPm} (architecture.json > package_manager); "${pm}" installs would create a second lockfile. Use ${chosenPm} instead.`;
    }
  }
  // pm-guard:end

  // Flags and their values may sit between the PM and the verb (`pnpm --filter x add`, `pnpm -w add`).
  if (/\b(pnpm|npm|yarn|bun)\b[^|;&\n]*\s(add|install|i|update|up)\b/.test(cmd)) {
    const hit = deferredDepInCommand(contract, cmd);
    if (hit) return `"${hit.dep}" cannot be installed. ${deferredHint(hit.deferred)}`;
  }

  if (writeRels.some(touchesProtectedPath)) return protectedMsg;
  for (const r of writeRels) if (packageOf(contract, r)) {
    const msg = pathRule(contract, r);
    if (msg) return msg;
  }
  return undefined;
}

function bashRule(ctx, cmd, depth = 0) {
  const own = directRule(ctx, cmd);
  if (own !== undefined) return own;
  if (depth >= 3)
    return cmd.matchAll(SHELL_STRING).next().done
      ? undefined
      : "Shell strings are nested too deeply to check; run the inner command directly.";
  // The same rules apply to the command string inside `bash -c "..."`, `sh -c '...'` and `eval "..."`.
  for (const m of cmd.matchAll(SHELL_STRING)) {
    const inner = m[1] === undefined ? m[2] : m[1].replace(/\\(["\\$`])/g, "$1");
    const msg = bashRule(ctx, inner, depth + 1);
    if (msg !== undefined) return msg;
  }
  return undefined;
}

/**
 * @param {{ tool: string, input?: any, contract: ReturnType<typeof import("./arch-contract.mjs").contractFrom>,
 *   root: string, home?: string, claudeMdText?: string, platform?: string | undefined }} args
 * @returns {{ allow: true } | { allow: false, message: string }}
 */
export function decide({ tool, input, contract, root, home = "~", claudeMdText, platform }) {
  const ti = input ?? {};
  const ci = CASE_INSENSITIVE.has(platform);
  const f = ci ? lower : (s) => s;
  const ctx = { contract: ci ? foldContract(contract) : contract, root: f(root), home: f(home), f, flags: ci ? "i" : "" };
  let message;
  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool))
    message = fileRule(ctx, tool, ti, claudeMdText);
  else if (tool === "Bash") message = bashRule(ctx, String(ti.command ?? ""));
  return message === undefined ? { allow: true } : { allow: false, message };
}
