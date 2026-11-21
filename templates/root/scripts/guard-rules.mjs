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
  if (tool === "Write") return String(ti.content ?? "").includes(text.slice(b, end)) ? undefined : msg;
  const edits = tool === "MultiEdit" ? (ti.edits ?? []) : [ti];
  for (const ed of edits) {
    const old = String(ed.old_string ?? "");
    if (!old) continue;
    for (let i = text.indexOf(old); i >= 0; i = text.indexOf(old, i + 1))
      if (i < end && i + old.length > b) return msg;
  }
  return undefined;
}

function fileRule(contract, root, tool, ti, claudeMdText) {
  const fp = ti.file_path ?? ti.notebook_path;
  if (!fp) return undefined;
  const r = toPosix(path.relative(root, path.resolve(root, fp)));
  return pathRule(contract, r) ?? (r === "CLAUDE.md" ? claudeMdRule(contract, tool, ti, claudeMdText) : undefined);
}

function bashRule(contract, root, home, cmd) {
  // Path-like tokens resolved against the project root; paths outside the project are ignored.
  const toRels = (tokens) =>
    tokens
      .map((t) => t.replace(/^~(?=\/)/, home))
      .map((t) => toPosix(path.relative(root, path.resolve(root, t))))
      .filter((r) => r && !r.startsWith("..") && !path.isAbsolute(r));
  const touchesProtectedPath = (r) => isProtectedOrDir(contract, r);
  const relTokens = toRels([...cmd.matchAll(/[^\s"'<>|;&()]+/g)].map((m) => m[0]));
  const touchesProtected = relTokens.some(touchesProtectedPath);

  if (
    relTokens.includes("CLAUDE.md") &&
    (/\b(sed\s+-i|perl\s+-p?i|rm|mv|cp|truncate)\b/.test(cmd) ||
      /(^|[^>])>\s*["']?\S*CLAUDE\.md/.test(cmd) ||
      /\btee\s+(?!-a)\S*CLAUDE\.md/.test(cmd))
  )
    return "CLAUDE.md must not be modified via Bash; use the Edit tool, outside the scaffold block only.";
  if (/--no-verify\b/.test(cmd) || /\bgit\s+commit\b[^|;&]*\s-n\b/.test(cmd))
    return "Skipping git hooks is forbidden (--no-verify).";
  if (/core\.hooksPath/.test(cmd) && !/\.githooks/.test(cmd)) return "Changing the git hooks path is forbidden.";
  if (/\bgit\s+(?:clean|checkout|restore|rm)\b/.test(cmd) && touchesProtected)
    return "Command touches a protected path via git; only humans may change it.";

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
  // A redirect writes only to its target; reading a protected file into a redirect is fine.
  const redirectRels = toRels(
    [...redirects.matchAll(/\d*>>?\s*["']?([^\s"'<>|;&()]+)/g)].map((m) => m[1]),
  );
  const protectedMsg = "Command touches a protected path; only humans may change it.";
  const firstPathRule = (rels) => {
    for (const r of rels) if (packageOf(contract, r)) {
      const msg = pathRule(contract, r);
      if (msg) return msg;
    }
    return undefined;
  };
  if (!writes && redirectRels.length) {
    if (redirectRels.some(touchesProtectedPath)) return protectedMsg;
    const msg = firstPathRule(redirectRels);
    if (msg) return msg;
  }
  if (writes) {
    if (touchesProtected) return protectedMsg;
    return firstPathRule(relTokens);
  }
  return undefined;
}

/**
 * @param {{ tool: string, input?: any, contract: ReturnType<typeof import("./arch-contract.mjs").contractFrom>,
 *   root: string, home?: string, claudeMdText?: string }} args
 * @returns {{ allow: true } | { allow: false, message: string }}
 */
export function decide({ tool, input, contract, root, home = "~", claudeMdText }) {
  const ti = input ?? {};
  let message;
  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool))
    message = fileRule(contract, root, tool, ti, claudeMdText);
  else if (tool === "Bash") message = bashRule(contract, root, home, String(ti.command ?? ""));
  return message === undefined ? { allow: true } : { allow: false, message };
}
