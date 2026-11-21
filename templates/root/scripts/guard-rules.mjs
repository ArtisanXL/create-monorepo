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
import { ASSIGNMENT, INTERPRETERS, SHELL_NAME, baseName, gitOptions, knownSafe, splitArgs, targetsOf } from "./shell-lex.mjs";

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


const WRITERS = new Set(["mkdir", "touch", "cp", "mv", "rm", "tee", "truncate", "ln", "install"]);
const EVAL_FLAG = /^(?:-[A-Za-z]*[ecEp]|--eval(?:=.*)?|--print(?:=.*)?)$/;
// Programs that run a command string given to their -c flag.
const COMMAND_STRING_RUNNERS = new Set(["su", "flock", "script", "runuser", "sg"]);
// Path lookups (words x directories) one decision may spend, shared by nested strings; past it the call is blocked.
const WORK_BUDGET = 30_000;
// Environment variables whose value is a command that some tool runs (`PAGER=rm man ls`).
const COMMAND_ENV = /^(?:PAGER|MANPAGER|GIT_PAGER|LESSOPEN|LESSCLOSE|GIT_EXTERNAL_DIFF|GIT_SSH_COMMAND|GIT_EDITOR|GIT_ASKPASS|SSH_ASKPASS|EDITOR|VISUAL|PROMPT_COMMAND|BROWSER)$/;


/** Command strings that other commands run: `$(...)`, `sh -c`, `eval`, `watch`, `su -c`, git aliases, pager variables, heredoc scripts. */
function innerStrings({ commands, nested, segments }) {
  const out = [...nested];
  for (const seg of segments) {
    addAll(out, seg.scriptBodies);
    // The other words a command-running option hands to that command (`rg --pre rm x file` runs `rm file`).
    const others = seg.words.filter((w) => !ASSIGNMENT.test(w.text) && !w.text.startsWith("-")).slice(1).map((w) => w.text).join(" ");
    seg.words.forEach((w, k) => {
      const env = ASSIGNMENT.test(w.text) ? /^([A-Za-z_]\w*)=(.*)$/s.exec(w.text) : null;
      if (env && (COMMAND_ENV.test(env[1]) || /^GIT_CONFIG_VALUE_\d+$/.test(env[1])))
        out.push(env[2].replace(/^[|!]/, "").replace(/%s/g, others));
      // A value with whitespace may be a command line that a later `eval $X` / `$X` / `bash -c '$X'` runs.
      else if (env && /\s/.test(env[2])) out.push({ text: env[2], hint: MSG.assignmentHint });
      const opt = /^--(?:pre|pager)(?:=(.*))?$/s.exec(w.text) ?? (seg.name === "man" ? /^-P(.*)$/s.exec(w.text) : null);
      if (opt) out.push(`${opt[1] || seg.words[k + 1]?.text || ""} ${others}`);
    });
  }
  for (const { name, args } of commands) {
    if (name === "eval" || name === "watch") out.push(args.filter((a) => name === "eval" || !a.text.startsWith("-")).map((a) => a.text).join(" "));
    else if (name === "git")
      args.forEach((a, i) => {
        // Any `-c key=value` may name a program git runs (gpg.program, diff.x.command, filter.x.clean, ...).
        const kv = a.text === "-c" ? /^([^=]+)=(.*)$/s.exec(args[i + 1]?.text ?? "") : null;
        if (kv) out.push(kv[2].replace(/^!/, ""));
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
  oneLiner:
    "Command touches a protected path through interpreter code; only humans may change it. Code that only reads a protected file is blocked too: read it with cat instead.",
  assignmentHint: "If this is a commit or PR message, pass it with `git commit -F -` or `gh ... --body-file -` and a heredoc instead of a variable.",
  runtime: "This command runs text built at run time (a pipe into a shell, a here-string, a script file, a variable as the command) and also names a write command and a protected path; only humans may change protected paths. Run the commands directly instead.",
  complex: "Command is too complex for the guard to check; split it into simpler commands.",
  nested: "Shell strings are nested too deeply to check; run the inner command directly.",
};

/** git clean/checkout/restore/rm/mv aimed at protected paths (also behind `sudo -u x git ...`). */
function gitRule(env, words, bases) {
  const { contract, relsOf, expand } = env;
  const at = words.findIndex((w) => !w.quoted && env.fold(baseName(w.text)) === "git");
  if (at < 0) return undefined;
  const args = words.slice(at + 1);
  const { i, dirs } = gitOptions(args);
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

// Whether any of the code texts names a protected path: a protected file, or a protected folder written
// as `folder/` or as a quoted literal.
function mentionsProtected(env, texts, bases) {
  for (const text of texts)
    for (const m of text.matchAll(/[^\s"'`<>|;&()]+/g)) {
      const t = m[0];
      for (const r of env.relsOf([t], bases)) {
        if (isProtected(env.contract, r)) return true;
        if (!isProtectedOrDir(env.contract, r) && !holdsProtected(env.contract, r)) continue;
        if (t.endsWith("/") || ["'", '"', "`"].some((q) => text.includes(q + t + q))) return true;
      }
    }
  return false;
}

/**
 * Interpreter one-liners (`node -e`, `python -c`, `deno eval`) hide the write inside a string; blocked
 * when the code mentions a protected path. Read-only code is blocked too: a read cannot be told from a write.
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
  return code && mentionsProtected(env, code.map((w) => w.text), bases) ? MSG.oneLiner : undefined;
}

const addAll = (list, items) => {
  for (const x of items) list.push(x);
};

/**
 * A write command, or a command named by a variable, behind prefixes the parser does not know
 * (`timeout 5 rm x`, `sudo -u root rm x`, `$X x`, `xargs rm` fed by a pipe or heredoc): every word counts as
 * a target. Only known-safe readers are skipped (`grep rm architecture.json`); their redirects are checked apart.
 */
function fallbackRule(env, parsed, idx, writeRels) {
  const { contract, fold: f, relsOf } = env;
  const s = parsed.segments[idx];
  if (knownSafe(s, f)) return undefined;
  const word = (w) => f(baseName(w.text));
  const at = s.words.findIndex((w, k) => {
    if (w.quoted && /\s/.test(w.text)) return false;
    const n = word(w);
    return WRITERS.has(n) || n === "dd" || ((n === "sed" || n === "perl") && inPlace(n, s.words.slice(k + 1).map((x) => x.text)));
  });
  const writer = at < 0 ? undefined : s.words[at];
  if (!writer && !s.words[0]?.text.startsWith("$")) return undefined;
  const wname = writer ? word(writer) : "";
  const after = s.words.slice(at < 0 ? 1 : at + 1);
  const prev = idx > s.pipeStart ? parsed.segments[idx - 1] : undefined;
  const bodyWords = (seg) => seg.bodies.flatMap((b) => b.split(/\s+/).filter(Boolean));
  const fed = s.words.some((w) => !w.quoted && word(w) === "xargs") ? [...(prev ? [...prev.words, ...bodyWords(prev)] : []), ...bodyWords(s)] : [];
  // Any word may be a target (a dd `of=` is unwrapped); only the words after the write command are checked as packages.
  const targets = [...fed, ...s.words].map((w) => (typeof w !== "string" && w.text.startsWith("of=") ? w.text.slice(3) : w));
  const rels = relsOf(targets, s.bases);
  const appends = after.some((w) => /^-[A-Za-z]*a|^--append/.test(w.text));
  if (rels.includes(f("CLAUDE.md")) && (["rm", "mv", "cp", "truncate", "sed", "perl"].includes(wname) || (wname === "tee" && !appends)))
    return MSG.claude;
  if (rels.some((r) => isProtectedOrDir(contract, r))) return MSG.protected;
  const folder = removeRule(env, { name: wname, args: after, bases: s.bases, tight: s.tight });
  if (folder) return folder;
  addAll(writeRels, relsOf(after.filter((w) => !w.text.startsWith("-")), s.bases));
  return undefined;
}

const inPlace = (name, flags) =>
  (name === "sed" && flags.some((x) => /^-[A-Za-z]*i|^--in-place/.test(x))) ||
  (name === "perl" && flags.some((x) => /^-[A-Za-z]*i/.test(x)));

const WRITE_WORD = /\b(?:mkdir|touch|cp|mv|rm|tee|truncate|ln|install|dd)\b|\bsed\s+-i|\bperl\s+-p?i/;

/**
 * Backstop for text that becomes a command at run time (`echo 'rm x' | sh`, `bash <<< '...'`, `bash <(...)`,
 * `bash script.sh`, `eval`, `$X` or `$(...)` as the command, `bash -c --`, `xargs -a`): it cannot be parsed
 * ahead, so the old rough check applies to the whole raw command, quotes included: a write word and a
 * protected path anywhere block it.
 */
function runtimeTextRule(env, cmd, parsed) {
  const { contract, fold: f } = env;
  const isFlag = (t) => t.startsWith("-");
  const dynamic = (w) => w.dyn || /\$[A-Za-z_{]|^\$$/.test(w.text);
  // Heredoc bodies are data (or checked on their own), so they are left out of the command-position test.
  let bare = cmd;
  for (const seg of parsed.segments) for (const b of seg.bodies) if (b) bare = bare.replace(b, "");
  // [ \t]* rather than \s*: a run of newlines must not be rescanned from every newline.
  let runtime = /(?:^|[;&|(\n])[ \t]*"?(?:\$[({\w]|`)/.test(bare);
  // Scripts under protected paths cannot have been changed by an agent; running one is not run-time text.
  const ownScripts = [];
  for (const [idx, s] of parsed.segments.entries()) {
    if (runtime) break;
    const texts = s.words.map((w) => w.text);
    if (s.words.some((w, k) => !w.quoted && f(baseName(w.text)) === "xargs" && texts.slice(k + 1).some((t) => /^-[A-Za-z]*a$|^--arg-file/.test(t)))) runtime = true;
    const k = s.words.findIndex((w) => !w.quoted && (SHELL_NAME.test(f(baseName(w.text))) || INTERPRETERS.test(f(baseName(w.text))) || [".", "source", "eval"].includes(w.text)));
    if (k < 0) continue;
    const name = f(baseName(texts[k]));
    const args = s.words.slice(k + 1);
    const after = texts.slice(k + 1);
    if (name === "eval") runtime = true;
    else if (SHELL_NAME.test(name) && after.some((t) => /^-[A-Za-z]*c$/.test(t))) {
      // `-c` takes a string; one built at run time (`"$(...)"`, `$X`, `--`, or nothing before a backtick) is run-time text.
      const j = after.findIndex((t) => /^-[A-Za-z]*c$/.test(t));
      if (!args[j + 1] || after[j + 1] === "--" || dynamic(args[j + 1])) runtime = true;
    } else {
      const inline = (name === "deno" && after[0] === "eval") || after.slice(0, after.findIndex((t) => !isFlag(t)) + 1 || after.length).some((t) => EVAL_FLAG.test(t));
      const file = after.find((t) => !isFlag(t));
      if (inline) continue;
      if (file === undefined) {
        if (idx > s.pipeStart || s.inputs.length > 0 || s.procSub) runtime = true;
      } else if (env.relsOf([file], s.bases).some((r) => isProtected(contract, r))) ownScripts.push(file);
      else if (!parsed.checked.has(path.normalize(file))) runtime = true;
    }
  }
  if (!runtime) return undefined;
  const REDIRECT_TO = />[>|]?[ \t]*["']?([^\s"'<>|;&()\\]+)/g;
  const tokens = [...cmd.matchAll(/[^\s"'<>|;&()\\]+/g)].map((m) => m[0]);
  const targets = [...cmd.matchAll(REDIRECT_TO)].map((m) => m[1]);
  const protectedIn = (words) => env.relsOf(words, [env.root]).some((r) => isProtectedOrDir(contract, r));
  // A redirect into a protected path is a write on its own; other writes need a write word.
  if (protectedIn(targets)) return MSG.runtime;
  if (!WRITE_WORD.test(cmd)) return undefined;
  return protectedIn(tokens.filter((t) => !ownScripts.includes(t))) ? MSG.runtime : undefined;
}

function directRule(ctx, cmd, parsed) {
  const { contract, root, f, expand, budget } = ctx;
  if (parsed.tooComplex) return MSG.complex;
  // Root-relative paths of the words, against each base; paths outside the project are ignored.
  // Every lookup spends from the shared budget; once it is gone nothing is resolved and the call is blocked.
  const relsOf = (words, bases, keepRoot = false) => {
    budget.left -= words.length * bases.length;
    if (budget.over || budget.left < 0) {
      budget.over = true;
      return [];
    }
    return words.flatMap((w) => {
      const e = expand(typeof w === "string" ? w : w.text);
      return bases.flatMap((b) => {
        const r = toPosix(path.relative(root, path.resolve(b, e)));
        return (keepRoot || r) && !r.startsWith("..") && !path.isAbsolute(r) ? [r] : [];
      });
    });
  };
  const env = { contract, root, expand, fold: f, relsOf };
  const claudeMd = f("CLAUDE.md");

  const writeRels = [];
  for (const r of parsed.redirects) {
    const rels = relsOf([r.target], r.bases);
    if (r.op === ">" && rels.includes(claudeMd)) return MSG.claude;
    addAll(writeRels, rels);
  }

  for (const [idx, s] of parsed.segments.entries()) {
    const msg =
      gitRule(env, s.words, s.bases) ??
      oneLinerRule(env, s.words, s.bases) ??
      (mentionsProtected(env, s.codeBodies, s.bases) ? MSG.oneLiner : undefined) ??
      fallbackRule(env, parsed, idx, writeRels);
    if (msg) return msg;
  }
  if (budget.over) return MSG.complex;

  for (const c of parsed.commands) {
    const { flags: fl, operands } = splitArgs(c.args);
    if (WRITERS.has(c.name) || inPlace(c.name, fl)) {
      const rels = relsOf(operands, c.bases);
      const appends = fl.some((x) => /^-[A-Za-z]*a|^--append/.test(x));
      if (rels.includes(claudeMd) && (["rm", "mv", "cp", "truncate", "sed", "perl"].includes(c.name) || (c.name === "tee" && !appends)))
        return MSG.claude;
      addAll(writeRels, rels);
    }
    if (c.name === "dd")
      for (const a of c.args) if (a.text.startsWith("of=")) addAll(writeRels, relsOf([a.text.slice(3)], c.bases));
    // `--output=path` (git diff/log, ...) and `sort -o` / `less -o` write to their target.
    c.args.forEach((a, k) => {
      const long = /^--output(?:=(.*))?$/s.exec(a.text);
      const short = c.name === "sort" || c.name === "less" ? /^-[A-Za-z]*[oO](.*)$/s.exec(a.text) : null;
      const target = long ? (long[1] ?? c.args[k + 1]?.text) : short ? (short[1] || c.args[k + 1]?.text) : undefined;
      if (target) addAll(writeRels, relsOf([target], c.bases));
    });
    const msg = removeRule(env, c);
    if (msg) return msg;
  }
  const runtimeMsg = runtimeTextRule(env, cmd, parsed);
  if (runtimeMsg) return runtimeMsg;
  if (budget.over) return MSG.complex;
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

  if (budget.over) return MSG.complex;
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
  for (const item of inner) {
    const msg = bashRule(ctx, typeof item === "string" ? item : item.text, depth + 1);
    if (msg !== undefined) return typeof item === "string" ? msg : `${msg} ${item.hint}`;
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
  const ctx = { contract: ci ? foldContract(contract) : contract, root: f(root), f, expand, budget: { left: WORK_BUDGET, over: false } };
  let message;
  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool))
    message = fileRule(ctx, tool, ti, claudeMdText);
  else if (tool === "Bash") message = bashRule(ctx, String(ti.command ?? ""));
  return message === undefined ? { allow: true } : { allow: false, message };
}
