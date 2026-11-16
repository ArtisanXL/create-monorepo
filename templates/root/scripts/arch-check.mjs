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
  /(?:^|[\s;])(import|export)\s+(type\s+)?(?:([\w*{}\s,$]+?)\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

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
      // `import type ...` or `import { type A, type B } ...` (every binding type-prefixed) is type-only.
      const named = m[3]?.trim().match(/^\{([^}]*)\}$/);
      const items = named ? named[1].split(",").map((x) => x.trim()).filter(Boolean) : [];
      const isType = Boolean(m[2]) || (items.length > 0 && items.every((x) => /^type\s/.test(x)));
      const s = m[4] ?? m[5];
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
