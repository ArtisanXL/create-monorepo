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

const WRAPPERS = new Set([
  "sudo", "time", "env", "command", "exec", "nohup", "nice", "corepack", "npx", "bunx", "xargs", "builtin",
]);
const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "{", "}"]);
const ASSIGNMENT = /^[A-Za-z_]\w*=/;
const WRITERS = new Set(["mkdir", "touch", "cp", "mv", "rm", "tee", "truncate", "ln", "install"]);
const INTERPRETERS = /^(?:node|nodejs|bun|deno|python[\d.]*|perl|ruby|php|tsx|ts-node)$/;
const EVAL_FLAG = /^(?:-[A-Za-z]*[ecEp]|--eval(?:=.*)?|--print(?:=.*)?)$/;
// Programs that run a command string given to their -c flag.
const COMMAND_STRING_RUNNERS = new Set(["su", "flock", "script", "runuser", "sg"]);
const SHELL_NAME = /^(?:ba|z|da|k|a)?sh$/;
const MAX_CDS = 32;
const MAX_COMMAND_LENGTH = 200_000;
const baseName = (w) => w.replace(/^.*[\\/]/, "");

/**
 * Splits a shell command into simple commands: quotes are removed, `;` `&&` `||` `|` `&` newlines,
 * parentheses and backticks separate commands, and redirects (`>`, `>>`, `>|`, `>&file`, `&>`) are
 * collected apart from the words. `$(...)` and backticks inside double quotes are returned in `nested`
 * as command strings of their own. Each segment records the operator that ended it (`sep`).
 * Heredoc bodies are not understood (their lines parse as commands).
 */
function shellSegments(cmd) {
  const segments = [];
  const nested = [];
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
  const end = (sep) => {
    pushWord();
    pending = null;
    if (words.length || redirs.length) segments.push({ words, redirs, sep });
    words = [];
    redirs = [];
  };
  const grow = () => {
    cur ??= { text: "", quoted: false };
    return cur;
  };
  // Index just past the `)` closing the `$(` whose `(` is at i; quotes inside are skipped.
  const closeParen = (i) => {
    let depth = 0;
    for (; i < cmd.length; i++) {
      const c = cmd[i];
      if (c === "\\") i++;
      else if (c === "'") i = cmd.indexOf("'", i + 1) < 0 ? cmd.length : cmd.indexOf("'", i + 1);
      else if (c === "(") depth++;
      else if (c === ")" && --depth === 0) return i;
    }
    return cmd.length;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "\\") {
      if (cmd[i + 1] === "\n") i++;
      else if (i + 1 < cmd.length) grow().text += cmd[++i];
    } else if (c === "$" && (cmd[i + 1] === "'" || cmd[i + 1] === '"')) {
      // $'...' and $"..." quote like '...' and "...": drop the $.
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
        else if (cmd[i] === "$" && cmd[i + 1] === "(") {
          const e = closeParen(i + 1);
          nested.push(cmd.slice(i + 2, e));
          i = e;
          continue;
        } else if (cmd[i] === "`") {
          let e = i + 1;
          while (e < cmd.length && cmd[e] !== "`") e += cmd[e] === "\\" ? 2 : 1;
          nested.push(cmd.slice(i + 1, e));
          i = e;
          continue;
        }
        cur.text += cmd[i];
      }
    } else if (c === " " || c === "\t" || c === "\r") pushWord();
    else if (c === "|") {
      const sep = cmd[i + 1] === "|" ? "||" : "|";
      end(sep);
      if (sep === "||") i++;
    } else if (c === "\n" || c === ";" || c === "(" || c === ")" || c === "`") end(";");
    else if (c === "&" && cmd[i + 1] !== ">") {
      const sep = cmd[i + 1] === "&" ? "&&" : "&";
      end(sep);
      if (sep === "&&") i++;
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
  end("");
  return { segments, nested };
}

/** Drops assignments, keywords and wrapper prefixes (and their flags); `find -exec` yields its inner command too. */
function commandsOf(words, fold) {
  let i = 0;
  while (i < words.length) {
    const w = words[i].text;
    if (ASSIGNMENT.test(w) || KEYWORDS.has(w)) i++;
    else if (WRAPPERS.has(fold(baseName(w)))) {
      i++;
      while (i < words.length && words[i].text.startsWith("-")) i++;
    } else break;
  }
  if (i >= words.length) return [];
  const name = fold(baseName(words[i].text));
  const args = words.slice(i + 1);
  const out = [{ name, args }];
  if (name === "find") {
    const k = args.findIndex((a) => /^-(?:exec|execdir|ok|okdir)$/.test(a.text));
    if (k >= 0) out.push(...commandsOf(args.slice(k + 1), fold));
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
 * `bases` are absolute and grow linearly: the project root, the chain of every `cd` / `pushd` target
 * assuming each succeeds, and every target resolved against the root alone (a `cd` can fail).
 * `tight` is the directory after the latest `cd` chained with `&&` or `;` (a `cd x || cmd` keeps it).
 * `tooComplex` is set past MAX_CDS directory changes or MAX_COMMAND_LENGTH characters.
 * @param {string} cmd
 * @param {string} root
 * @param {(t: string) => string} [expand] applied to every path word (home, case folding)
 * @param {(t: string) => string} [fold] applied to command names
 */
export function targetsOf(cmd, root, expand = (t) => t, fold = (t) => t) {
  const commands = [];
  const redirects = [];
  const segments = [];
  if (cmd.length > MAX_COMMAND_LENGTH) return { commands, redirects, segments, nested: [], tooComplex: true };
  const parsed = shellSegments(cmd);
  let chain = root;
  let bases = [root];
  let tight = [root];
  let cds = 0;
  let pipeStart = 0;
  for (const seg of parsed.segments) {
    for (const r of seg.redirs) redirects.push({ op: r.op, target: r.target, bases });
    segments.push({ words: seg.words, pipeStart, bases });
    if (seg.sep !== "|") pipeStart = segments.length;
    for (const c of commandsOf(seg.words, fold)) {
      commands.push({ ...c, bases, tight });
      if (c.name !== "cd" && c.name !== "pushd") continue;
      const dir = splitArgs(c.args).operands[0];
      if (!dir || dir.text === "-") continue;
      if (++cds > MAX_CDS) return { commands, redirects, segments, nested: parsed.nested, tooComplex: true };
      chain = path.resolve(chain, expand(dir.text));
      bases = [...new Set([...bases, chain, path.resolve(root, expand(dir.text))])];
      if (seg.sep === "&&" || seg.sep === ";") tight = [chain];
    }
  }
  return { commands, redirects, segments, nested: parsed.nested, tooComplex: false };
}

/** Command strings that other commands run: `$(...)`, `sh -c`, `eval`, `watch`, `su -c`, git aliases. */
function innerStrings({ commands, nested }) {
  const out = [...nested];
  for (const { name, args } of commands) {
    if (name === "eval" || name === "watch") out.push(args.filter((a) => name === "eval" || !a.text.startsWith("-")).map((a) => a.text).join(" "));
    else if (name === "git")
      args.forEach((a, i) => {
        const alias = a.text === "-c" ? /^alias\.[^=]+=!(.*)$/s.exec(args[i + 1]?.text ?? "") : null;
        if (alias) out.push(alias[1]);
      });
    else if (SHELL_NAME.test(name) || COMMAND_STRING_RUNNERS.has(name))
      for (let i = 0; i < args.length; i++) {
        const t = args[i].text;
        if (/^-[A-Za-z]*c$/.test(t) && args[i + 1]) out.push(args[i + 1].text);
        else if (t.startsWith("--command=")) out.push(t.slice("--command=".length));
        else continue;
        break;
      }
  }
  return out;
}

const MSG = {
  claude: "CLAUDE.md must not be modified via Bash; use the Edit tool, outside the scaffold block only.",
  protected: "Command touches a protected path; only humans may change it.",
  git: "Command touches a protected path via git; only humans may change it.",
  folder: "Command would delete or move a folder that contains protected paths; only humans may change them.",
  oneLiner: "Command touches a protected path through an interpreter one-liner; only humans may change it.",
  complex: "Command is too complex for the guard to check; split it into simpler commands.",
  nested: "Shell strings are nested too deeply to check; run the inner command directly.",
};

/** git clean/checkout/restore/rm/mv aimed at protected paths (also behind `sudo -u x git ...`). */
function gitRule(env, words, bases) {
  const { contract, relsOf, expand } = env;
  const at = words.findIndex((w) => !w.quoted && env.fold(baseName(w.text)) === "git");
  if (at < 0) return undefined;
  const args = words.slice(at + 1);
  let i = 0;
  const dirs = [];
  for (; i < args.length; i++) {
    const t = args[i].text;
    if (t === "-C" || t === "-c" || /^--(?:git-dir|work-tree|namespace)$/.test(t)) {
      if (t === "-C" && args[i + 1]) dirs.push(args[i + 1].text);
      i++;
    } else if (!t.startsWith("-")) break;
  }
  const sub = args[i] && env.fold(args[i].text);
  if (!["clean", "checkout", "restore", "rm", "mv"].includes(sub ?? "")) return undefined;
  const gb = [...bases, ...dirs.map((d) => path.resolve(env.root, expand(d)))];
  const g = splitArgs(args.slice(i + 1));
  if (relsOf(g.operands, gb).some((r) => isProtectedOrDir(contract, r) || holdsProtected(contract, r))) return MSG.git;
  // A whole-tree revert from a revision rewrites protected files too: `checkout <rev> -- .`, `restore --source=<rev> .`.
  const dots = g.operands.filter((o) => o.text === "." || o.text === "./" || o.text === ":/");
  const fromRev =
    (sub === "checkout" && g.operands.length > dots.length) ||
    (sub === "restore" && g.flags.some((x) => /^(?:--source|-s)/.test(x)));
  return dots.length && fromRev ? MSG.git : undefined;
}

/** rm / mv of a folder that holds protected paths; `rm -rf .` only when no `cd` moved elsewhere first. */
function removeRule(env, c) {
  if (c.name !== "rm" && c.name !== "mv") return undefined;
  const { flags, operands } = splitArgs(c.args);
  const byTarget = flags.some((x) => /^--target-directory|^-[A-Za-z]*t$/.test(x));
  const sources = c.name === "rm" || byTarget ? operands : operands.slice(0, -1);
  const holds = env.relsOf(sources, c.bases).some((r) => holdsProtected(env.contract, r));
  return holds || (c.name === "rm" && env.relsOf(sources, c.tight, true).includes("")) ? MSG.folder : undefined;
}

/**
 * Interpreter one-liners hide the write inside a string; blocked when they mention a protected path
 * (a protected file, or a protected folder written as `folder/` or as a quoted literal). Read-only
 * one-liners that mention one are blocked too: a read cannot be told from a write.
 */
function oneLinerRule(env, words, bases) {
  const at = words.findIndex((w) => !w.quoted && INTERPRETERS.test(env.fold(baseName(w.text))));
  if (at < 0) return undefined;
  const args = words.slice(at + 1);
  let code;
  if (env.fold(baseName(words[at].text)) === "deno" && args[0]?.text === "eval") code = args.slice(1);
  else
    for (let i = 0; i < args.length; i++) {
      const t = args[i].text;
      if (!t.startsWith("-")) break;
      if (EVAL_FLAG.test(t)) {
        code = args.slice(i + 1);
        break;
      }
      if (/^--?(?:r|require|import|loader|experimental-loader)$/.test(t)) i++;
    }
  for (const w of code ?? [])
    for (const m of w.text.matchAll(/[^\s"'`<>|;&()]+/g)) {
      const t = m[0];
      const pathLike = t.endsWith("/") || ["'", '"', "`"].some((q) => w.text.includes(q + t + q));
      for (const r of env.relsOf([t], bases))
        if (isProtected(env.contract, r) || (pathLike && (isProtectedOrDir(env.contract, r) || holdsProtected(env.contract, r))))
          return MSG.oneLiner;
    }
  return undefined;
}

function directRule(ctx, cmd, parsed) {
  const { contract, root, f, expand } = ctx;
  if (parsed.tooComplex) return MSG.complex;
  // Root-relative paths of the words, against each base; paths outside the project are ignored.
  const relsOf = (words, bases, keepRoot = false) =>
    words.flatMap((w) =>
      bases.flatMap((b) => {
        const r = toPosix(path.relative(root, path.resolve(b, expand(typeof w === "string" ? w : w.text))));
        return (keepRoot || r) && !r.startsWith("..") && !path.isAbsolute(r) ? [r] : [];
      }),
    );
  const env = { contract, root, expand, fold: f, relsOf };
  const claudeMd = f("CLAUDE.md");

  const writeRels = [];
  for (const r of parsed.redirects) {
    const rels = relsOf([r.target], r.bases);
    if (r.op === ">" && rels.includes(claudeMd)) return MSG.claude;
    writeRels.push(...rels);
  }

  for (const [idx, s] of parsed.segments.entries()) {
    const msg = gitRule(env, s.words, s.bases) ?? oneLinerRule(env, s.words, s.bases);
    if (msg) return msg;
    // A write command or a command named by a variable behind prefixes the parser does not know
    // (`timeout 5 rm x`, `sudo -u root rm x`, `$X x`, `xargs rm` fed by a pipe): every word counts as a target.
    const word = (w) => f(baseName(w.text));
    const writer = s.words.find((w) => !w.quoted && (WRITERS.has(word(w)) || word(w) === "dd"));
    if (writer || s.words[0]?.text.startsWith("$")) {
      const fed = s.words.some((w) => !w.quoted && word(w) === "xargs") ? parsed.segments.slice(s.pipeStart, idx).flatMap((x) => x.words) : [];
      // Any word may be a target, but only the words after the write command are checked as packages.
      const rels = relsOf([...fed, ...s.words], s.bases);
      if (rels.includes(claudeMd) && writer && ["rm", "mv", "cp", "truncate"].includes(word(writer))) return MSG.claude;
      if (rels.some((r) => isProtectedOrDir(contract, r))) return MSG.protected;
      writeRels.push(...relsOf(s.words.slice(writer ? s.words.indexOf(writer) + 1 : 1).filter((w) => !w.text.startsWith("-")), s.bases));
    }
  }

  for (const c of parsed.commands) {
    const { flags: fl, operands } = splitArgs(c.args);
    const isWriter =
      WRITERS.has(c.name) ||
      (c.name === "sed" && fl.some((x) => /^-[A-Za-z]*i|^--in-place/.test(x))) ||
      (c.name === "perl" && fl.some((x) => /^-[A-Za-z]*i/.test(x)));
    if (isWriter) {
      const rels = relsOf(operands, c.bases);
      const appends = fl.some((x) => /^-[A-Za-z]*a|^--append/.test(x));
      if (rels.includes(claudeMd) && (["rm", "mv", "cp", "truncate", "sed", "perl"].includes(c.name) || (c.name === "tee" && !appends)))
        return MSG.claude;
      writeRels.push(...rels);
    }
    if (c.name === "dd")
      for (const a of c.args) if (a.text.startsWith("of=")) writeRels.push(...relsOf([a.text.slice(3)], c.bases));
    const msg = removeRule(env, c);
    if (msg) return msg;
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

  if (writeRels.some((r) => isProtectedOrDir(contract, r))) return MSG.protected;
  for (const r of writeRels) if (packageOf(contract, r)) {
    const msg = pathRule(contract, r);
    if (msg) return msg;
  }
  return undefined;
}

function bashRule(ctx, cmd, depth = 0) {
  const parsed = targetsOf(cmd, ctx.root, ctx.expand, ctx.f);
  const own = directRule(ctx, cmd, parsed);
  if (own !== undefined) return own;
  // The same rules apply to every command string another command runs (`bash -c`, `eval`, `$(...)`...).
  const inner = innerStrings(parsed);
  if (depth >= 3) return inner.length ? MSG.nested : undefined;
  for (const s of inner) {
    const msg = bashRule(ctx, s, depth + 1);
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
  const expand = (t) => f(t.replace(/^~(?=\/)/, home));
  const ctx = { contract: ci ? foldContract(contract) : contract, root: f(root), f, expand };
  let message;
  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool))
    message = fileRule(ctx, tool, ti, claudeMdText);
  else if (tool === "Bash") message = bashRule(ctx, String(ti.command ?? ""));
  return message === undefined ? { allow: true } : { allow: false, message };
}
