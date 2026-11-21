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
const INTERPRETER = /\b(?:node|nodejs|bun|deno|python[\d.]*|perl|ruby|php)\b[^|;&\n]*?\s-(?:e|c|p|pe|E|r|-eval|-print)\b/;

function directRule({ contract, root, home, f, flags }, cmd) {
  // Path-like tokens resolved against the project root (or a directory a `cd` / `git -C` moved to);
  // paths outside the project are ignored.
  const toRels = (tokens, base = ".", keepRoot = false) =>
    tokens
      .map((t) => f(t.replace(/^~(?=\/)/, home)))
      .map((t) => toPosix(path.relative(root, path.resolve(root, base, t))))
      .filter((r) => (keepRoot || r) && !r.startsWith("..") && !path.isAbsolute(r));
  const touchesProtectedPath = (r) => isProtectedOrDir(contract, r);
  const tokens = [...cmd.matchAll(/[^\s"'<>|;&()]+/g)].map((m) => m[0]);
  // Relative targets after `cd dir && ...` or `git -C dir ...` are also tried against that directory.
  const dirs = [
    ...[...cmd.matchAll(/\bcd\s+["']?([^\s"';&|)]+)/g)].map((m) => m[1]),
    ...[...cmd.matchAll(/\bgit\s+(?:\S+\s+)*?-C\s+["']?([^\s"';&|)]+)/g)].map((m) => m[1]),
  ].map((d) => f(d.replace(/^~(?=\/)/, home)));
  const bases = [".", ...dirs];
  const relsOf = (list, keepRoot) => bases.flatMap((b) => toRels(list, b, keepRoot));
  const relTokens = relsOf(tokens);
  const touchesProtected = relTokens.some(touchesProtectedPath);
  const holdsAny = relTokens.some((r) => holdsProtected(contract, r));

  if (
    relTokens.includes(f("CLAUDE.md")) &&
    (/\b(sed\s+-i|perl\s+-p?i|rm|mv|cp|truncate)\b/.test(cmd) ||
      new RegExp("(^|[^>])>\\s*[\"']?\\S*CLAUDE\\.md", flags).test(cmd) ||
      new RegExp("\\btee\\s+(?!-a)\\S*CLAUDE\\.md", flags).test(cmd))
  )
    return "CLAUDE.md must not be modified via Bash; use the Edit tool, outside the scaffold block only.";
  if (/--no-verify\b/.test(cmd) || /\bgit\s+commit\b[^|;&]*\s-n\b/.test(cmd))
    return "Skipping git hooks is forbidden (--no-verify).";
  if (/core\.hooksPath/.test(cmd) && !/\.githooks/.test(cmd)) return "Changing the git hooks path is forbidden.";
  if (
    /\bgit\s+(?:(?:-[cC]|--git-dir|--work-tree|--namespace)\s+\S+\s+|-\S+\s+)*(?:clean|checkout|restore|rm)\b/.test(cmd) &&
    (touchesProtected || holdsAny)
  )
    return "Command touches a protected path via git; only humans may change it.";

  // rm / mv of a folder that holds protected paths (`rm -rf docs`, `mv scripts x`) destroys them.
  // Globs (`rm -rf d*`) and `find -delete` are not resolved; CI arch-check is the backstop.
  for (const m of cmd.matchAll(/(?:^|[;&|(\s])(rm|mv)\s+([^;&|\n)]*)/g)) {
    const args = m[2].split(/\s+/).map((a) => a.replace(/^["']|["']$/g, "")).filter((a) => a && !a.startsWith("-"));
    const sources = m[1] === "rm" ? args : args.slice(0, -1);
    if (relsOf(sources, true).some((r) => (r === "" ? m[1] === "rm" : holdsProtected(contract, r))))
      return "Command would delete or move a folder that contains protected paths; only humans may change them.";
  }

  // Interpreter one-liners hide the write inside a string; blocked when they name a protected path.
  // This also blocks read-only one-liners that mention one (`node -e "require('./architecture.json')"`).
  if (INTERPRETER.test(cmd) && (touchesProtected || holdsAny))
    return "Command touches a protected path through an interpreter one-liner; only humans may change it.";

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

  const redirects = cmd.replace(/\d*>&\d/g, "").replace(/\d*>\s*\/dev\/null/g, "");
  const writes = /\b(mkdir|touch|cp|mv|rm|tee|truncate|ln|install)\b|\bsed\s+-i|\bperl\s+-p?i/.test(redirects);
  // A redirect (or dd's of=) writes only to its target; reading a protected file into a redirect is fine.
  const redirectRels = relsOf([
    ...[...redirects.matchAll(/\d*>>?\s*["']?([^\s"'<>|;&()]+)/g)].map((m) => m[1]),
    ...[...cmd.matchAll(/\bdd\b[^|;&\n]*?\bof=["']?([^\s"']+)/g)].map((m) => m[1]),
  ]);
  const protectedMsg = "Command touches a protected path; only humans may change it.";
  const firstPathRule = (rels) => {
    for (const r of rels) if (packageOf(contract, r)) {
      const msg = pathRule(contract, r);
      if (msg) return msg;
    }
    return undefined;
  };
  if (redirectRels.some(touchesProtectedPath)) return protectedMsg;
  if (!writes) return firstPathRule(redirectRels);
  if (touchesProtected) return protectedMsg;
  return firstPathRule(relTokens);
}

function bashRule(ctx, cmd, depth = 0) {
  const own = directRule(ctx, cmd);
  if (own !== undefined || depth >= 3) return own;
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
