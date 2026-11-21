#!/usr/bin/env node
// PreToolUse: blocks writes to protected files, undeclared packages, deferred dependencies and
// hook bypass attempts (exit 2 → the tool call is cancelled and the message goes to the agent).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  claudeBlockSpan,
  deferredDepInCommand,
  deferredHint,
  isProtected,
  isProtectedOrDir,
  loadContract,
  packageOf,
} from "../../scripts/arch-contract.mjs";

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const arch = loadContract(root);

const block = (msg) => {
  process.stderr.write(`⛔ ${msg}\nRules: CLAUDE.md and architecture.json.\n`);
  process.exit(2);
};
const hint = deferredHint;

function checkPath(r) {
  if (r.startsWith("..") || path.isAbsolute(r)) return;
  if (isProtected(arch, r))
    block(`${r} is protected; only humans may change it. If a change is needed, write an ADR draft under docs/adr/proposed/ and ask the user.`);
  const owner = packageOf(arch, r);
  if (owner && !owner.declared)
    block(`${owner.dir} is not a package declared in architecture.json. ${owner.deferred ? hint(owner.deferred) : "Adding a package requires an accepted ADR."}`);
}

const tool = input.tool_name;
const ti = input.tool_input ?? {};

/** CLAUDE.md: blocks edits touching the scaffold block; outside the block is free. */
function checkClaudeMd() {
  const p = path.join(root, "CLAUDE.md");
  if (!arch.claudeBlock || !existsSync(p)) return;
  const text = readFileSync(p, "utf8");
  const span = claudeBlockSpan(text, arch.claudeBlock);
  if (!span) return;
  const { start: b, end } = span;
  const msg = "The scaffold block in CLAUDE.md is protected; edit only outside the block.";
  if (tool === "Write") {
    if (!String(ti.content ?? "").includes(text.slice(b, end))) block(msg);
    return;
  }
  const edits = tool === "MultiEdit" ? (ti.edits ?? []) : [ti];
  for (const ed of edits) {
    const old = String(ed.old_string ?? "");
    if (!old) continue;
    for (let i = text.indexOf(old); i >= 0; i = text.indexOf(old, i + 1))
      if (i < end && i + old.length > b) block(msg);
  }
}

if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
  const fp = ti.file_path ?? ti.notebook_path;
  if (fp) {
    const r = path.relative(root, path.resolve(root, fp)).split(path.sep).join("/");
    checkPath(r);
    if (r === "CLAUDE.md") checkClaudeMd();
  }
}

if (tool === "Bash") {
  const cmd = String(ti.command ?? "");
  // Path-like tokens resolved against the project root; paths outside the project are ignored.
  const home = process.env.HOME ?? "~";
  const toRels = (tokens) =>
    tokens
      .map((t) => t.replace(/^~(?=\/)/, home))
      .map((t) => path.relative(root, path.resolve(root, t)).split(path.sep).join("/"))
      .filter((r) => r && !r.startsWith("..") && !path.isAbsolute(r));
  const touchesProtectedPath = (r) => isProtectedOrDir(arch, r);
  const relTokens = toRels([...cmd.matchAll(/[^\s"'<>|;&()]+/g)].map((m) => m[0]));
  const touchesProtected = relTokens.some(touchesProtectedPath);

  if (
    relTokens.includes("CLAUDE.md") &&
    (/\b(sed\s+-i|perl\s+-p?i|rm|mv|cp|truncate)\b/.test(cmd) ||
      /(^|[^>])>\s*["']?\S*CLAUDE\.md/.test(cmd) ||
      /\btee\s+(?!-a)\S*CLAUDE\.md/.test(cmd))
  )
    block("CLAUDE.md must not be modified via Bash; use the Edit tool, outside the scaffold block only.");
  if (/--no-verify\b/.test(cmd) || /\bgit\s+commit\b[^|;&]*\s-n\b/.test(cmd))
    block("Skipping git hooks is forbidden (--no-verify).");
  if (/core\.hooksPath/.test(cmd) && !/\.githooks/.test(cmd)) block("Changing the git hooks path is forbidden.");
  if (/\bgit\s+(clean|checkout\s+--|restore|rm)\b/.test(cmd) && touchesProtected)
    block("Command touches a protected path via git; only humans may change it.");

  // pm-guard:begin
  const chosenPm = arch.packageManager;
  if (chosenPm) {
    // Optional command prefixes: sudo/time/env/corepack..., their flags and VAR=value assignments.
    const wrappers =
      "(?:(?:sudo|time|env|command|exec|nohup|nice|corepack)\\s+|-\\S+\\s+|[A-Za-z_]\\w*=\\S*\\s+)*";
    for (const pm of ["pnpm", "npm", "yarn", "bun"].filter((x) => x !== chosenPm)) {
      const install = new RegExp(
        `(^|[;&|(])\\s*${wrappers}${pm}(\\s*($|[;&|)])|\\s+(install|i|add|ci|update|up|upgrade)\\b)`,
      );
      if (cmd.split("\n").some((l) => install.test(l)))
        block(`This project uses ${chosenPm} (architecture.json > package_manager); "${pm}" installs would create a second lockfile. Use ${chosenPm} instead.`);
    }
  }
  // pm-guard:end

  // Flags and their values may sit between the PM and the verb (`pnpm --filter x add`, `pnpm -w add`).
  if (/\b(pnpm|npm|yarn|bun)\b[^|;&\n]*\s(add|install|i|update|up)\b/.test(cmd)) {
    const hit = deferredDepInCommand(arch, cmd);
    if (hit) block(`"${hit.dep}" cannot be installed. ${hint(hit.deferred)}`);
  }

  const redirects = cmd.replace(/\d*>&\d/g, "").replace(/\d*>\s*\/dev\/null/g, "");
  const writes = /\b(mkdir|touch|cp|mv|rm|tee|truncate|ln|install)\b|\bsed\s+-i|\bperl\s+-p?i/.test(redirects);
  // A redirect writes only to its target; reading a protected file into a redirect is fine.
  const redirectRels = toRels(
    [...redirects.matchAll(/\d*>>?\s*["']?([^\s"'<>|;&()]+)/g)].map((m) => m[1]),
  );
  if (!writes && redirectRels.length) {
    if (redirectRels.some(touchesProtectedPath)) block("Command touches a protected path; only humans may change it.");
    for (const r of redirectRels) if (packageOf(arch, r)) checkPath(r);
  }
  if (writes) {
    if (touchesProtected) block("Command touches a protected path; only humans may change it.");
    for (const r of relTokens) if (packageOf(arch, r)) checkPath(r);
  }
}

process.exit(0);
