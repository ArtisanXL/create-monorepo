# --- Architecture check script -----------------------------------------------------------
emit scripts/arch-check.mjs <<'EOF'
#!/usr/bin/env node
// Enforces the contract in architecture.json. Dependency-free; does not need the TS compiler API.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const arch = JSON.parse(readFileSync(path.join(root, "architecture.json"), "utf8"));

/** sha256 of the CLAUDE.md scaffold block (markers included); null if missing. */
function claudeBlockHash() {
  const cb = arch.claude_md_block;
  const p = path.join(root, "CLAUDE.md");
  if (!cb || !existsSync(p)) return null;
  const text = readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  const b = text.indexOf(cb.begin);
  const e = b < 0 ? -1 : text.indexOf(cb.end, b);
  if (e < 0) return null;
  return createHash("sha256").update(text.slice(b, e + cb.end.length)).digest("hex");
}
// A human intentionally changed the block: `pnpm arch --claude-hash` → write it into architecture.json.
if (process.argv.includes("--claude-hash")) {
  console.log(claudeBlockHash() ?? "CLAUDE.md scaffold block not found");
  process.exit(0);
}

const { scope, packages } = arch;
const deferred = arch.deferred ?? [];
const testAllow = new Set(arch.test_allow ?? []);
const errors = [];
const err = (m) => errors.push(m);
const rel = (p) => path.relative(root, p).split(path.sep).join("/");

const nameToDir = new Map(Object.keys(packages).map((d) => [`${scope}/${path.basename(d)}`, d]));
const deferredByPath = new Map(deferred.filter((d) => d.path).map((d) => [d.path, d]));
const forbiddenDeps = new Map(deferred.flatMap((d) => (d.deps ?? []).map((dep) => [dep, d])));
const hint = (d) =>
  `deferred "${d.name}". Trigger: ${d.trigger} If needed, write an ADR draft under docs/adr/proposed/ and ask a human.`;
const pkgNameOf = (spec) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name === ".turbo") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (readdirSync(p).length === 0) err(`${rel(p)}: empty folder (placeholders are forbidden)`);
      yield* walk(p);
    } else yield p;
  }
}

// 1) Only declared packages under apps/ and packages/
for (const group of ["apps", "packages"]) {
  const g = path.join(root, group);
  if (!existsSync(g)) continue;
  for (const e of readdirSync(g, { withFileTypes: true })) {
    const dir = `${group}/${e.name}`;
    if (packages[dir]) continue;
    const d = deferredByPath.get(dir);
    err(`${dir}: not declared in architecture.json — ${d ? hint(d) : "new packages require an accepted ADR."}`);
  }
}

// 2) Deferred dependencies must not appear anywhere (root + catalog included)
const depsOf = (pj) => ({ ...pj.dependencies, ...pj.devDependencies, ...pj.peerDependencies, ...pj.optionalDependencies });
const rootPj = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
for (const dep of Object.keys(depsOf(rootPj))) {
  const d = forbiddenDeps.get(dep);
  if (d) err(`package.json → ${dep}: ${hint(d)}`);
}
const ws = readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
for (const [dep, d] of forbiddenDeps) {
  const re = new RegExp(`^\\s+["']?${dep.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}["']?\\s*:`, "m");
  if (re.test(ws)) err(`pnpm-workspace.yaml catalog → ${dep}: ${hint(d)}`);
}

// 3) Per-package checks
const IMPORT_RE =
  /(?:^|[\s;])(import|export)\s+(type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

for (const [dir, spec] of Object.entries(packages)) {
  const abs = path.join(root, dir);
  const pjPath = path.join(abs, "package.json");
  if (!existsSync(pjPath)) {
    err(`${dir}: package.json missing`);
    continue;
  }
  if (!spec.adr || spec.adr.includes("/proposed/") || !existsSync(path.join(root, spec.adr)))
    err(`${dir}: missing or invalid accepted ADR reference (${spec.adr ?? "-"})`);

  const pj = JSON.parse(readFileSync(pjPath, "utf8"));
  const expected = `${scope}/${path.basename(dir)}`;
  if (pj.name !== expected) err(`${dir}: package name must be "${expected}" (found: ${pj.name})`);

  const mayDepend = new Set(spec.may_depend_on ?? []);
  const typeOnly = new Set(spec.type_only ?? []);
  const extAllow = spec.external_allow ? new Set(spec.external_allow) : null;

  for (const dep of Object.keys(depsOf(pj))) {
    const target = nameToDir.get(dep);
    if (target) {
      if (!mayDepend.has(target) && !typeOnly.has(target))
        err(`${dir} → ${dep}: dependency not allowed (allowed: ${[...mayDepend, ...typeOnly].join(", ") || "none"})`);
    } else if (dep.startsWith(`${scope}/`)) err(`${dir} → ${dep}: unknown workspace package`);
    else if (forbiddenDeps.has(dep)) err(`${dir} → ${dep}: ${hint(forbiddenDeps.get(dep))}`);
    else if (extAllow && !extAllow.has(dep) && !testAllow.has(dep))
      err(`${dir} → ${dep}: external dependency not in allow list (${[...extAllow].join(", ") || "none"})`);
  }

  for (const file of walk(abs)) {
    const r = rel(file);
    if (path.basename(file) === ".gitkeep") err(`${r}: placeholder files are forbidden`);
    if (!/\.(ts|tsx|mts|cts|js|mjs|jsx)$/.test(file)) continue;
    const src = readFileSync(file, "utf8");
    if (/@ts-(ignore|nocheck)/.test(src)) err(`${r}: @ts-ignore / @ts-nocheck are forbidden`);
    if (/^\s*export\s*\{\s*\}\s*;?\s*$/.test(src)) err(`${r}: empty module (export {}) — placeholders are forbidden`);
    const isTest = /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);

    for (const m of src.matchAll(IMPORT_RE)) {
      const isType = Boolean(m[2]);
      const s = m[3] ?? m[4];
      if (!s) continue;
      if (s.startsWith(".")) {
        const resolved = path.resolve(path.dirname(file), s);
        if (!resolved.startsWith(abs + path.sep)) err(`${r}: relative import outside the package ("${s}")`);
        continue;
      }
      const name = pkgNameOf(s);
      if (name.startsWith(`${scope}/`)) {
        const target = nameToDir.get(name);
        if (!target) err(`${r}: unknown workspace package "${name}"`);
        else if (target === dir) err(`${r}: a package must not import itself by name ("${s}")`);
        else if (typeOnly.has(target) && !isType) err(`${r}: "${name}" may only be imported with \`import type\``);
        else if (!mayDepend.has(target) && !typeOnly.has(target)) err(`${r}: import of "${name}" is not allowed`);
        continue;
      }
      if (forbiddenDeps.has(name)) {
        err(`${r}: "${name}" ${hint(forbiddenDeps.get(name))}`);
        continue;
      }
      if (extAllow && !(isTest && testAllow.has(name))) {
        const ok = s.startsWith("node:") ? extAllow.has("node:*") : extAllow.has(name);
        if (!ok) err(`${r}: import of "${s}" is not allowed (${dir} external allow list: ${[...extAllow].join(", ") || "none"})`);
      }
    }
  }
}

// 4) The CLAUDE.md scaffold block must exist and be unchanged (outside the block is free)
if (arch.claude_md_block) {
  const h = claudeBlockHash();
  if (!h) err("CLAUDE.md: scaffold block missing");
  else if (h !== arch.claude_md_block.sha256)
    err("CLAUDE.md: scaffold block was modified. Humans only; if intentional, write the output of `pnpm arch --claude-hash` into architecture.json > claude_md_block.sha256.");
}

if (errors.length) {
  console.error(`✗ Architecture check failed (${errors.length}):\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  console.error("\nRules: CLAUDE.md, architecture.json, docs/adr/");
  process.exit(1);
}
console.log(`✓ Architecture check passed (${Object.keys(packages).length} packages)`);
EOF

# --- Claude Code hooks -------------------------------------------------------------------
emit .claude/settings.json <<'EOF'
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit|NotebookEdit|Bash",
        "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/guard.mjs" }]
      }
    ],
    "Stop": [
      {
        "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/stop-check.mjs" }]
      }
    ]
  }
}
EOF

emit .claude/hooks/guard.mjs <<'EOF'
#!/usr/bin/env node
// PreToolUse: blocks writes to protected files, undeclared packages, deferred dependencies and
// hook bypass attempts (exit 2 → the tool call is cancelled and the message goes to the agent).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const arch = JSON.parse(readFileSync(path.join(root, "architecture.json"), "utf8"));
const allowed = new Set(Object.keys(arch.packages));
const deferred = arch.deferred ?? [];
const protectedPaths = arch.protected_paths ?? [];
const exceptions = arch.agent_writable_exceptions ?? [];

const block = (msg) => {
  process.stderr.write(`⛔ ${msg}\nRules: CLAUDE.md and architecture.json.\n`);
  process.exit(2);
};
const hint = (d) =>
  `This is deferred "${d.name}" (trigger: ${d.trigger}). If you think it is needed, stop, write an ADR draft under docs/adr/proposed/ and ask the user.`;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const isProtected = (r) =>
  !exceptions.some((e) => r.startsWith(e)) &&
  protectedPaths.some((p) => (p.endsWith("/") ? r.startsWith(p) : r === p));

function checkPath(r) {
  if (r.startsWith("..") || path.isAbsolute(r)) return;
  if (isProtected(r))
    block(`${r} is protected; only humans may change it. If a change is needed, write an ADR draft under docs/adr/proposed/ and ask the user.`);
  const m = r.match(/^(apps|packages)\/([^/]+)/);
  if (m && !allowed.has(`${m[1]}/${m[2]}`)) {
    const dir = `${m[1]}/${m[2]}`;
    const d = deferred.find((x) => x.path === dir);
    block(`${dir} is not a package declared in architecture.json. ${d ? hint(d) : "Adding a package requires an accepted ADR."}`);
  }
}

const tool = input.tool_name;
const ti = input.tool_input ?? {};

/** CLAUDE.md: blocks edits touching the scaffold block; outside the block is free. */
function checkClaudeMd() {
  const cb = arch.claude_md_block;
  const p = path.join(root, "CLAUDE.md");
  if (!cb || !existsSync(p)) return;
  const text = readFileSync(p, "utf8");
  const b = text.indexOf(cb.begin);
  const e = b < 0 ? -1 : text.indexOf(cb.end, b);
  if (e < 0) return;
  const end = e + cb.end.length;
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
  const relTokens = [...cmd.matchAll(/[^\s"'<>|;&()]+/g)]
    .map((m) => m[0].replace(/^~(?=\/)/, home))
    .map((t) => path.relative(root, path.resolve(root, t)).split(path.sep).join("/"))
    .filter((r) => r && !r.startsWith("..") && !path.isAbsolute(r));
  const touchesProtected = relTokens.some(
    (r) => isProtected(r) || protectedPaths.some((p) => p.endsWith("/") && r === p.slice(0, -1)),
  );

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

  if (/\b(pnpm|npm|yarn|bun)\s+(add|install|i|update|up)\b/.test(cmd)) {
    for (const d of deferred)
      for (const dep of d.deps ?? [])
        if (new RegExp(`(^|[\\s"'])${esc(dep)}(@[^\\s"']*)?(?=$|[\\s"'])`).test(cmd))
          block(`"${dep}" cannot be installed. ${hint(d)}`);
  }

  const redirects = cmd.replace(/\d*>&\d/g, "").replace(/\d*>\s*\/dev\/null/g, "");
  const writes = /\b(mkdir|touch|cp|mv|rm|tee|truncate|ln|install)\b|\bsed\s+-i|\bperl\s+-p?i|>/.test(redirects);
  if (writes) {
    if (touchesProtected) block("Command touches a protected path; only humans may change it.");
    for (const r of relTokens) if (/^(apps|packages)\/[^/]+/.test(r)) checkPath(r);
  }
}

process.exit(0);
EOF

emit .claude/hooks/stop-check.mjs <<'EOF'
#!/usr/bin/env node
// Stop: architecture + lint checks must pass before the agent finishes (exit 2 → agent continues).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
if (input.stop_hook_active) process.exit(0); // avoid infinite loops
const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const run = (cmd, args) => spawnSync(cmd, args, { cwd: root, encoding: "utf8" });

const checks = [["architecture", run(process.execPath, ["scripts/arch-check.mjs"])]];
const biome = path.join(root, "node_modules", ".bin", "biome");
if (existsSync(biome)) checks.push(["lint", run(biome, ["check", "."])]);

const failed = checks.filter(([, r]) => r.status !== 0);
if (failed.length) {
  const out = failed.map(([n, r]) => `## ${n}\n${r.stdout ?? ""}${r.stderr ?? ""}`).join("\n");
  process.stderr.write(`Fix these checks before finishing (pnpm verify):\n${out.slice(-6000)}`);
  process.exit(2);
}
process.exit(0);
EOF

# --- Git hook + CI -----------------------------------------------------------------------
emit .githooks/pre-commit <<'EOF'
#!/bin/sh
set -e
pnpm -s arch
pnpm -s lint
EOF
chmod +x .githooks/pre-commit scripts/arch-check.mjs .claude/hooks/*.mjs

emit .github/workflows/ci.yml <<'EOF'
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v5
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm verify
      - run: pnpm build
EOF

emit .github/CODEOWNERS <<'EOF'
# Architecture contract files require human review. Replace OWNER with a GitHub user/team
# and uncomment the lines below.
# /architecture.json        OWNER
# /CLAUDE.md                OWNER
# /docs/adr/                OWNER
# /scripts/arch-check.mjs   OWNER
# /.claude/                 OWNER
# /.github/                 OWNER
EOF

