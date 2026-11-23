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
import { ASSIGNMENT, INTERPRETERS, KEYWORDS, SHELL_NAME, baseName, gitOptions, knownSafe, splitArgs, targetsOf } from "./shell-lex.mjs";

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


const WRITERS = new Set(["mkdir", "touch", "cp", "mv", "rm", "tee", "truncate", "ln", "install", "chmod", "chown", "chgrp", "unlink", "shred", "rmdir"]);
const EVAL_FLAG = /^(?:-[A-Za-z]*[ecEp]|--eval(?:=.*)?|--print(?:=.*)?)$/;
// Programs that run a command string given to their -c flag.
const COMMAND_STRING_RUNNERS = new Set(["su", "flock", "script", "runuser", "sg"]);
// Path lookups (words x directories) one decision may spend, shared by nested strings; past it the call is blocked.
const WORK_BUDGET = 30_000;
// Environment variables whose value is a command that some tool runs (`PAGER=rm man ls`).
const COMMAND_ENV = /^(?:PAGER|MANPAGER|GIT_PAGER|LESSOPEN|LESSCLOSE|GIT_EXTERNAL_DIFF|GIT_SSH_COMMAND|GIT_EDITOR|GIT_ASKPASS|SSH_ASKPASS|EDITOR|VISUAL|PROMPT_COMMAND|BROWSER)$/;


/** Command strings that other commands run: `$(...)`, `sh -c`, `eval`, `watch`, `su -c`, git aliases, pager variables, heredoc scripts. */
function innerStrings({ commands, nested, segments, vars }) {
  const out = [...nested];
  for (const seg of segments) {
    addAll(out, seg.scriptBodies);
    // A here-string fed to a shell is a script (`bash <<< "npm install"`).
    if (seg.words.some((w) => !w.quoted && SHELL_NAME.test(baseName(w.text)))) for (const x of seg.inputs) if (x.op === "<<<") out.push(x.target);
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
        // `--config-env=key=VAR` takes the value from an environment variable; one assigned in this line is a command too.
        const ce = configEnv(args, i);
        if (ce) for (const v of assignedValues({ vars, segments }, ce.env)) out.push(v.replace(/^!/, ""));
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
  gitConfig: "git -c include.path / includeIf pulls in a config file the guard cannot inspect; set the options you need directly.",
  gitConfigEnv:
    "git --config-env names an environment variable the guard cannot see; assign it in the same command or pass the value directly.",
  reset: "git reset --hard to another revision rewrites protected files too; only humans may do that. Plain `git reset --hard`, `--hard HEAD`, `HEAD~N` and `git reset --soft` are fine.",
  decode:
    "A decoded or decompressed stream is run by a shell or interpreter, so the guard cannot inspect it. Decode it to a file you can read, or run the commands directly.",
  script:
    "A shell script is given a protected path as an argument; the guard cannot see what the script does with it. Run the commands directly instead.",
  glob: "A glob in this delete or move could match protected paths (or a folder inside one); name the files or folders explicitly, and quote a name that really contains `*`.",
  findRoot:
    "find would delete from the project root, which covers protected paths; start the search in a subfolder (`find src -name x -delete`) instead.",
  formatted:
    "Text formatted at run time (printf with a format, echo -e with escapes) is piped into a shell or interpreter, so the guard cannot see the command. Write the command out directly instead.",
  rewind:
    "git reset / checkout / switch / read-tree to another revision, or a whole-tree restore after one, rewrites protected files too; only humans may do that. Branch switches, `git checkout -b <name>` and path checkouts are fine.",
  complex: "Command is too complex for the guard to check; split it into simpler commands.",
  nested: "Shell strings are nested too deeply to check; run the inner command directly.",
};

/** git clean/checkout/restore/rm/mv aimed at protected paths (also behind `sudo -u x git ...`). */
// HEAD and revisions relative to it (`HEAD~2`, `HEAD^`, `@{u}`, `HEAD@{1}`, `ORIG_HEAD`): resetting to them stays in the current history.
const HEAD_RELATIVE = /^(?:HEAD|@)?(?:~\d*|\^\d*|@\{[^}]*\})*$|^ORIG_HEAD$/;
const INCLUDE_KEY = /^include(?:if\..+)?\.path$/i;
// Config keys that name a program or file git runs or reads.
const COMMAND_KEY = /pager|editor|ssh|askpass|fsmonitor|external|textconv|command|driver|clean|smudge|process|helper|program|hookspath|alias|include|exec/i;

/** `--config-env=key=VAR` (or `--config-env key=VAR`) at args[i]. */
function configEnv(args, i) {
  const t = args[i].text;
  const v = t.startsWith("--config-env=") ? t.slice("--config-env=".length) : t === "--config-env" ? (args[i + 1]?.text ?? "") : undefined;
  const m = v === undefined ? null : /^([^=]*)=(.*)$/s.exec(v);
  return m ? { key: m[1], env: m[2] } : undefined;
}

/** Values the line assigns to a variable: assignment-only segments and `VAR=x cmd` prefixes. */
function assignedValues({ vars, segments }, name) {
  const out = [];
  if (vars?.has(name)) out.push(vars.get(name));
  for (const s of segments) for (const w of s.words) if (w.text.startsWith(`${name}=`)) out.push(w.text.slice(name.length + 1));
  return out;
}

/** Whether a git pathspec glob could match a protected path (or something inside a protected folder). */
function globHitsProtected(contract, rel) {
  const star = rel.search(/[*?[]/);
  if (star < 0) return false;
  if (rel.length > 512) return true;
  const head = rel.slice(0, star);
  // Fails closed: a pattern the regex engine cannot compile or run counts as a hit.
  try {
    const re = new RegExp(`^${rel.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
    for (const p of contract.protectedPaths) {
      const dir = p.endsWith("/");
      const parts = (dir ? p.slice(0, -1) : p).split("/");
      for (let k = 1; k <= parts.length; k++) if (re.test(parts.slice(0, k).join("/"))) return true;
      if (dir && (head.startsWith(p) || (rel[star] === "*" && p.startsWith(head)))) return true;
    }
  } catch {
    return true;
  }
  return false;
}

// Revisions that cannot be a branch name: an object id, FETCH_HEAD, ORIG_HEAD, refs/..., or anything with `~`, `^` or `@{`
// (`HEAD@{0}` is the current commit).
const HEAD_ONLY = /^(?:HEAD|@)?$/;
const CURRENT = /^(?:HEAD|@)@?(?:\{0\})?$/;
const isRevision = (t) =>
  !t.startsWith(":") && !CURRENT.test(t) && /^[0-9a-f]{7,40}$|^ORIG_HEAD|^FETCH_HEAD|^refs\/|[~^]|@\{/i.test(t);
// Whole-tree pathspecs: `.`, `:/`, `*`, `:(top)`.
const WHOLE_TREE = /^(?:\.\/?|:\/\.?|\*|:\(top\)[.*]?)$/;

/**
 * Whether the line moves HEAD or the index to another revision (`git reset <rev>` other than `--soft`, `git read-tree <rev>`):
 * a whole-tree restore after it rewrites protected files. Only the first operand before `--` is a revision.
 * It sees one command line: a reset in one call and the checkout in the next is not connected.
 */
function rewinds(env, parsed) {
  parsed.rewound ??= parsed.segments.some((s) => {
    const at = s.words.findIndex((w) => !w.quoted && env.fold(baseName(w.text)) === "git");
    if (at < 0) return false;
    const args = s.words.slice(at + 1);
    const { i } = gitOptions(args);
    const sub = args[i]?.text;
    if (sub !== "reset" && sub !== "read-tree") return false;
    const rest = args.slice(i + 1);
    const dd = rest.findIndex((a) => a.text === "--");
    const before = dd < 0 ? rest : rest.slice(0, dd);
    if (before.some((a) => a.text === "--soft" || a.text === "-n")) return false;
    const first = before.find((a) => !a.text.startsWith("-"));
    return first !== undefined && !HEAD_RELATIVE.test(first.text);
  });
  return parsed.rewound;
}

/** `git checkout <rev>` / `-b name <rev>` / `--detach <x>` with no paths: switches the whole tree to that revision. */
function checksOutRevision(g, rest) {
  const isRev = (o) => isRevision(o.text);
  if (rest.some((a) => a.text === "--") && rest.slice(rest.findIndex((a) => a.text === "--") + 1).length) return false;
  const revs = g.operands.filter(isRev);
  const creates = g.flags.some((x) => /^-[A-Za-z]*[bB]$|^--orphan$/.test(x));
  if (g.flags.includes("--detach") && g.operands.some((o) => !HEAD_ONLY.test(o.text))) return true;
  return revs.length > 0 && g.operands.length - revs.length <= (creates ? 1 : 0);
}

function gitRule(env, words, bases, parsed) {
  const { contract, relsOf, expand } = env;
  const at = words.findIndex((w) => !w.quoted && env.fold(baseName(w.text)) === "git");
  if (at < 0) return undefined;
  const args = words.slice(at + 1);
  const { i, dirs } = gitOptions(args);
  const sub = args[i] && env.fold(args[i].text);
  for (let k = 0; k < i; k++) {
    const key = args[k].text === "-c" ? /^[^=]*/.exec(args[k + 1]?.text ?? "")[0] : undefined;
    if (key !== undefined && INCLUDE_KEY.test(key)) return MSG.gitConfig;
    const ce = configEnv(args, k);
    if (!ce) continue;
    if (INCLUDE_KEY.test(ce.key)) return MSG.gitConfig;
    if (COMMAND_KEY.test(ce.key) && !assignedValues(parsed, ce.env).length) return MSG.gitConfigEnv;
  }
  if (sub === "reset") {
    const r = splitArgs(args.slice(i + 1));
    return r.flags.some((x) => /^--(?:hard|keep|merge)$/.test(x)) && r.operands.some((o) => !HEAD_RELATIVE.test(o.text)) ? MSG.reset : undefined;
  }
  if (sub === "stash") return rewinds(env, parsed) ? MSG.rewind : undefined;
  if (sub === "read-tree") {
    const r = splitArgs(args.slice(i + 1));
    return r.flags.some((x) => /^-[A-Za-z]*u|^--reset$/.test(x)) ? MSG.rewind : undefined;
  }
  if (sub === "switch") {
    const r = splitArgs(args.slice(i + 1));
    const detach = r.flags.some((x) => /^(?:--detach|-d)$/.test(x)) && r.operands.some((o) => !HEAD_ONLY.test(o.text));
    return detach || r.operands.some((o) => isRevision(o.text)) ? MSG.rewind : undefined;
  }
  if (sub === "checkout-index") {
    const r = splitArgs(args.slice(i + 1));
    return rewinds(env, parsed) && r.flags.some((x) => /^-[A-Za-z]*a|^--all$/.test(x)) ? MSG.rewind : undefined;
  }
  if (!["clean", "checkout", "restore", "rm", "mv"].includes(sub ?? "")) return undefined;
  const gb = [...bases, ...dirs.map((d) => path.resolve(env.root, expand(d)))];
  const g = splitArgs(args.slice(i + 1));
  if (relsOf(g.operands, gb).some((r) => isProtectedOrDir(contract, r) || holdsProtected(contract, r))) return MSG.git;
  // A whole-tree revert from a revision rewrites protected files too: `checkout <rev> -- .`, `restore --source=<rev> .`.
  const dots = g.operands.filter((o) => WHOLE_TREE.test(o.text));
  // A whole-tree restore reads the index, which an earlier `git reset <rev>` on the line may have rewound.
  const force = sub === "checkout" && g.flags.some((x) => /^-[A-Za-z]*f|^--force$/.test(x)) && g.operands.every((o) => HEAD_ONLY.test(o.text));
  if ((dots.length || force) && rewinds(env, parsed)) return MSG.rewind;
  if (sub === "checkout" && checksOutRevision(g, args.slice(i + 1))) return MSG.rewind;
  const fromRev =
    (sub === "checkout" && g.operands.length > dots.length) ||
    (sub === "restore" && g.flags.some((x) => /^(?:--source|-s)/.test(x)));
  if (dots.length && fromRev) return MSG.git;
  // A glob after a revision restores every path it matches: `checkout HEAD~5 -- '*'`, `restore -s rev '*.json'`.
  const glob = (o) => /[*?[]/.test(o.text);
  const rest = args.slice(i + 1);
  const dd = rest.findIndex((a) => a.text === "--");
  const hasRev =
    sub === "restore"
      ? g.flags.some((x) => /^(?:--source|-s)/.test(x))
      : sub === "checkout" && (dd >= 0 ? rest.slice(0, dd).some((a) => !a.text.startsWith("-")) : g.operands.some((o) => !glob(o)));
  if (hasRev && g.operands.filter(glob).some((o) => relsOf([o], gb).some((r) => globHitsProtected(contract, r)))) return MSG.git;
  return undefined;
}

const GLOB = /[*?[]/;

/** Whether a shell glob (each `*` / `?` / `[..]` stays inside one path segment) could match a protected path, or, when `folders`, a folder holding one. */
function shellGlobHits(contract, rel, folders) {
  if (!GLOB.test(rel)) return false;
  if (contract.exceptions.some((e) => rel.startsWith(e))) return false;
  const segs = rel.split("/");
  if (rel.length > 512 || (rel.match(/[*?[]/g) ?? []).length > 12) return true;
  try {
    const match = (pat, name) =>
      !GLOB.test(pat) ||
      /\[[:.=]/.test(pat) ||
      new RegExp(`^${pat.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\[!/g, "[^").replace(/\*+/g, "[^/]*").replace(/\?/g, "[^/]")}$`).test(name);
    for (const p of contract.protectedPaths) {
      const dir = p.endsWith("/");
      const parts = (dir ? p.slice(0, -1) : p).split("/");
      if (!segs.slice(0, parts.length).every((g, j) => match(g, parts[j]) && (GLOB.test(g) || g === parts[j]))) continue;
      if (segs.length === parts.length || (folders && segs.length < parts.length) || (dir && segs.length > parts.length)) return true;
    }
  } catch {
    return true;
  }
  return false;
}

/** rm / mv of a folder that holds protected paths; `rm -rf .` only when no `cd` moved elsewhere first. */
function removeRule(env, c) {
  const recursive = ["chmod", "chown", "chgrp"].includes(c.name) && c.args.some((a) => /^-[A-Za-z]*R|^--recursive$/.test(a.text));
  if (!DELETERS.has(c.name) && !recursive) return undefined;
  const { flags, operands } = splitArgs(c.args);
  const byTarget = flags.some((x) => /^--target-directory|^-[A-Za-z]*t$/.test(x));
  const sources = c.name !== "mv" || byTarget ? operands : operands.slice(0, -1);
  const holds = env.relsOf(sources, c.bases).some((r) => holdsProtected(env.contract, r));
  if (holds || (c.name === "rm" && env.relsOf(sources, c.tight, true).includes(""))) return MSG.folder;
  // A glob (`rm -rf d*`) is resolved against the directory the command really runs in, not every `cd` that might have failed.
  // A quoted word is a literal name.
  const recursiveRm = c.name !== "rm" || flags.some((x) => /^-[A-Za-z]*[rR]|^--recursive$/.test(x));
  const globs = sources.filter((w) => !w.quoted && GLOB.test(w.text ?? w));
  return env.relsOf(globs, c.tight).some((r) => shellGlobHits(env.contract, r, recursiveRm)) ? MSG.glob : undefined;
}

const DELETERS = new Set(["rm", "mv", "shred", "unlink", "rmdir"]);

/** `find <folder holding protected paths> ... -delete | -exec rm`, and `rsync` into protected paths or `--delete` into a folder holding them. */
function bulkRule(env, c) {
  const { contract, relsOf } = env;
  if (c.name === "find") {
    const start = [];
    for (const a of c.args) {
      if (/^-|^[()!]$/.test(a.text)) break;
      start.push(a);
    }
    const k = c.args.findIndex((a) => /^-(?:exec|execdir|ok|okdir)$/.test(a.text));
    const deletes = c.args.some((a) => a.text === "-delete") || (k >= 0 && DELETERS.has(env.fold(baseName(c.args[k + 1]?.text ?? ""))));
    if (!deletes) return undefined;
    // The search covers every protected path when it starts at the project root (or nowhere: the default is `.`).
    if (relsOf(start.length ? start : ["."], c.tight, true).includes("")) return MSG.findRoot;
    if (relsOf(start, c.bases).some((r) => isProtectedOrDir(contract, r) || holdsProtected(contract, r))) return MSG.folder;
    return relsOf(start.filter((w) => !w.quoted && GLOB.test(w.text)), c.tight).some((r) => shellGlobHits(contract, r, true)) ? MSG.glob : undefined;
  }
  if (c.name === "rsync") {
    const { flags, operands } = splitArgs(c.args);
    const dest = relsOf(operands.slice(-1), c.bases);
    if (dest.some((r) => isProtectedOrDir(contract, r))) return MSG.protected;
    return flags.some((x) => /^--(?:delete|remove-source-files)/.test(x)) && dest.some((r) => holdsProtected(contract, r)) ? MSG.folder : undefined;
  }
  return undefined;
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
  const head = s.words.find((w) => !KEYWORDS.has(w.text));
  if (!writer && !head?.text.startsWith("$") && !head?.fromVar) return undefined;
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
  // `echo docs | xargs rm -rf`: the words that feed xargs are the folders it removes.
  const fedWords = wname === "rm" && after.some((w) => /^-[A-Za-z]*[rR]|^--recursive$/.test(w.text)) ? fed.map((w) => (typeof w === "string" ? { text: w } : w)) : [];
  const folder = removeRule(env, { name: wname, args: [...fedWords, ...after], bases: s.bases, tight: s.tight });
  if (folder) return folder;
  addAll(writeRels, relsOf(after.filter((w) => !w.text.startsWith("-")), s.bases));
  return undefined;
}

const inPlace = (name, flags) =>
  (name === "sed" && flags.some((x) => /^-[A-Za-z]*i|^--in-place/.test(x))) ||
  (name === "perl" && flags.some((x) => /^-[A-Za-z]*i/.test(x)));

const WRITE_WORD = /\b(?:mkdir|touch|cp|mv|rm|tee|truncate|ln|install|dd|chmod|chown|chgrp|unlink|shred|rmdir)\b|\bsed\s+-i|\bperl\s+-p?i/;
// File-changing calls of interpreters (node fs, python os/shutil/pathlib, perl): counted when an interpreter runs run-time text.
const INTERP_WRITE = new RegExp(
  [
    // node fs: fs.unlinkSync(, fs.promises.rm(, writeFile(, ...
    String.raw`\b(?:unlink|unlinkSync|rmSync|rmdirSync|writeFile|writeFileSync|appendFile|appendFileSync|rename|renameSync|copyFile|copyFileSync|cpSync|truncate|truncateSync|createWriteStream|symlinkSync|chmodSync)\s*\(`,
    String.raw`\.(?:rm|rmdir|cp|copy|unlink|write_text|write_bytes|rename|replace|touch|symlink_to|chmod)\s*\(`,
    // python: os.remove(, shutil.rmtree(, ...
    String.raw`\bos\.(?:remove|unlink|rename|replace|removedirs|rmdir|truncate|chmod|chown|symlink|link)\s*\(`,
    String.raw`\bshutil\.\w+\s*\(`,
    // perl: unlink 'x', rename(...)
    String.raw`\b(?:unlink|rmdir|rename|truncate|chmod|chown|symlink)(?=[ \t(])`,
    // open(path, "w" | "a" | "+")
    String.raw`\bopen\w*\s*\(\s*[^,()]+,\s*["'][rwabxt+]*[wa+][rwabxt+]*["']`,
    String.raw`\bopen\b[^;\n]{0,80}["']\s*\+?>`,
  ].join("|"),
);
// A recursive delete, `-delete`, `--delete` or a move: with a folder that holds protected paths it destroys them.
const FOLDER_DELETE = /\brm[ \t]+(?:-\S+[ \t]+){0,5}?-[A-Za-z]*[rR]|\brm\b.{0,20}--recursive|[ \t]-delete\b|--delete|\bmv\b|\brmdir\b/;
// Text formatted at run time: printf with a format or escape, `echo -e` with an escape.
const FORMATTED = /\bprintf\b[^|;&\n]*[%\\]|\becho[ \t]+-[A-Za-z]*e[^|;&\n]*\\/;
// Decoders and decompressors; their output piped into a shell or interpreter cannot be inspected.
const DECODER =
  /\b(?:base64|base32|basenc)\b.{0,40}?(?:[ \t]-[A-Za-z]*[dD]\b|--decode)|\bxxd\b.{0,40}?[ \t]-[A-Za-z]*r|\bopenssl\b.{0,40}?[ \t]-d\b|\b(?:gunzip|gzcat|zcat|bzcat|xzcat|unxz|bunzip2|unzstd|zstdcat|uudecode)\b|\b(?:gzip|bzip2|xz|zstd)\b.{0,30}?[ \t]-[A-Za-z]*d[A-Za-z]*\b/;

/**
 * Backstop for text that becomes a command at run time (`echo 'rm x' | sh`, `bash <<< '...'`, `bash <(...)`,
 * `bash script.sh`, `eval`, `$X` or `$(...)` as the command, `bash -c --`, `xargs -a`, `node` reading stdin):
 * it cannot be parsed ahead, so the old rough check applies to the whole raw command, quotes included: a write
 * word and a protected path anywhere block it. A folder holding protected paths counts when a recursive delete,
 * `-delete` or `--delete` is named, and with an interpreter its file-changing calls count as write words.
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
  // `strong` is run-time text of unknown content; running a script file is `runtime` but not `strong`.
  let strong = runtime;
  // Scripts under protected paths cannot have been changed by an agent; running one is not run-time text.
  const ownScripts = [];
  let interpreter = false;
  for (const [idx, s] of parsed.segments.entries()) {
    if (s.words.some((w) => !w.quoted && INTERPRETERS.test(f(baseName(w.text))))) interpreter = true;
    if (strong) continue;
    const texts = s.words.map((w) => w.text);
    if (s.words.some((w, k) => !w.quoted && f(baseName(w.text)) === "xargs" && texts.slice(k + 1).some((t) => /^-[A-Za-z]*a$|^--arg-file/.test(t)))) runtime = strong = true;
    const k = s.words.findIndex((w) => !w.quoted && (SHELL_NAME.test(f(baseName(w.text))) || INTERPRETERS.test(f(baseName(w.text))) || [".", "source", "eval"].includes(w.text)));
    if (k < 0) continue;
    const name = f(baseName(texts[k]));
    const args = s.words.slice(k + 1);
    const after = texts.slice(k + 1);
    if (name === "eval") runtime = strong = true;
    else if (SHELL_NAME.test(name) && after.some((t) => /^-[A-Za-z]*c$/.test(t))) {
      // `-c` takes a string; one built at run time (`"$(...)"`, `$X`, `--`, or nothing before a backtick) is run-time text.
      const j = after.findIndex((t) => /^-[A-Za-z]*c$/.test(t));
      if (!args[j + 1] || after[j + 1] === "--" || dynamic(args[j + 1])) runtime = strong = true;
    } else {
      const leading = after.slice(0, after.findIndex((t) => !isFlag(t)) + 1 || after.length);
      // `-e` is errexit for a shell, not code.
      const scriptRunner = SHELL_NAME.test(name) || name === "." || name === "source";
      const evalAt = scriptRunner ? -1 : name === "deno" && after[0] === "eval" ? 0 : leading.findIndex((t) => EVAL_FLAG.test(t));
      const file = after.find((t) => !isFlag(t));
      if (evalAt >= 0 && (name === "deno" || !/^-.*=/.test(leading[evalAt]))) {
        // An interpreter's `-c` / `-e` string built at run time (`python3 -c "$(echo ...)"`) is run-time text too.
        const code = args[evalAt + 1];
        if (!code || code.dyn || code.text === "$" || (!code.quoted && dynamic(code))) runtime = strong = true;
        continue;
      }
      if (evalAt >= 0) continue;
      if (file === undefined) {
        if (idx > s.pipeStart || s.inputs.length > 0 || s.procSub) runtime = strong = true;
      } else if (env.relsOf([file], s.bases).some((r) => isProtected(contract, r))) ownScripts.push(file);
      else if (!parsed.checked.has(path.normalize(file))) {
        runtime = true;
        // A shell script that is not protected may do anything to the protected path it is handed.
        const given = args.slice(after.indexOf(file) + 1);
        if (scriptRunner && env.relsOf(given, s.bases).some((r) => isProtectedOrDir(contract, r) || holdsProtected(contract, r))) return MSG.script;
      }
    }
  }
  if (!runtime) return undefined;
  if (strong && DECODER.test(bare)) return MSG.decode;
  // printf / `echo -e` spell the command out only at run time (`printf 'r%s x' m | sh`), so nothing in the text can be checked.
  if (strong && FORMATTED.test(bare)) return MSG.formatted;
  const REDIRECT_TO = />[>|]?[ \t]*["']?([^\s"'<>|;&()\\]+)/g;
  // Adjacent empty quotes are dropped too (`'r''m'` runs rm), so both spellings are checked.
  const squashed = cmd.replace(/(?:''|"")+/g, "");
  for (const text of squashed === cmd ? [cmd] : [cmd, squashed]) {
    const tokens = [...text.matchAll(/[^\s"'<>|;&()\\]+/g)].flatMap((m) => (m[0].startsWith("of=") ? [m[0], m[0].slice(3)] : [m[0]]));
    const targets = [...text.matchAll(REDIRECT_TO)].map((m) => m[1]);
    const protectedIn = (words) => env.relsOf(words, [env.root]).some((r) => isProtectedOrDir(contract, r));
    // A redirect into a protected path is a write on its own; other writes need a write word.
    if (protectedIn(targets)) return MSG.runtime;
    const interpWrite = interpreter && INTERP_WRITE.test(text);
    const writes = WRITE_WORD.test(text) || interpWrite;
    const folderDelete = FOLDER_DELETE.test(text);
    // Interpreter code names a folder as a quoted string (`rmSync('docs')`), not as `docs/`.
    if (interpWrite && mentionsProtected(env, [text, text.replace(/\\/g, "")], [env.root])) return MSG.runtime;
    if (!writes && !folderDelete) continue;
    const seen = tokens.filter((t) => !ownScripts.includes(t));
    if (writes && protectedIn(seen)) return MSG.runtime;
    if (folderDelete && env.relsOf(seen, [env.root]).some((r) => holdsProtected(contract, r))) return MSG.runtime;
  }
  return undefined;
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
      gitRule(env, s.words, s.bases, parsed) ??
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
    const msg = removeRule(env, c) ?? bulkRule(env, c);
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

function bashRule(ctx, cmd, depth = 0, scope = undefined) {
  const parsed = targetsOf(cmd, ctx.root, ctx.expand, ctx.f, scope);
  const own = directRule(ctx, cmd, parsed);
  if (own !== undefined) return own;
  // The same rules apply to every command string another command runs (`bash -c`, `eval`, `$(...)`...).
  const inner = innerStrings(parsed);
  if (depth >= 3) return inner.length ? MSG.nested : undefined;
  for (const item of inner) {
    const msg = bashRule(ctx, typeof item === "string" ? item : item.text, depth + 1, { vars: parsed.vars, budget: parsed.budget });
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
