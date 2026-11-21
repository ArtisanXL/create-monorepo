// The architecture rules as a pure function over a snapshot of the repo: no filesystem, env or
// exit. scripts/arch-check.mjs gathers the snapshot and prints the result.
import path from "node:path";
import {
  claudeBlockHash,
  deferredDepsInCatalog,
  deferredHint,
  deferredOfDep,
  PACKAGE_GROUPS,
  packageOf,
} from "./arch-contract.mjs";

const IMPORT_RE =
  /(?:^|[\s;])(import|export)\s+(type\s+)?(?:([\w*{}\s,$]+?)\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

const depsOf = (pj) => ({
  ...pj.dependencies,
  ...pj.devDependencies,
  ...pj.peerDependencies,
  ...pj.optionalDependencies,
});
const pkgNameOf = (spec) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
const base = (p) => p.slice(p.lastIndexOf("/") + 1);

/**
 * @typedef {{ path: string, kind: "file" | "emptyDir", source?: string }} Entry  root-relative, walk order;
 *   `source` is set for code files only
 * @typedef {{
 *   contract: ReturnType<typeof import("./arch-contract.mjs").contractFrom>,
 *   rootPackageJson: any,
 *   catalogText: string,
 *   claudeMdText: string | null,
 *   groupDirs: Record<string, string[]>,
 *   packages: Record<string, { packageJson: any | null, adrExists: boolean, entries: Entry[] }>,
 * }} Snapshot
 */

/**
 * @param {Snapshot} snapshot
 * @returns {string[]}
 */
export function check(snapshot) {
  const { contract, rootPackageJson, catalogText, claudeMdText, groupDirs } = snapshot;
  const { scope, packages } = contract;
  const testAllow = new Set(contract.testAllow);
  const errors = [];
  const err = (m) => errors.push(m);
  const hint = deferredHint;
  const forbidden = (dep) => deferredOfDep(contract, dep);
  const nameToDir = new Map(Object.keys(packages).map((d) => [`${scope}/${base(d)}`, d]));

  // 1) Only declared packages under apps/ and packages/
  for (const group of PACKAGE_GROUPS)
    for (const name of groupDirs[group] ?? []) {
      const owner = packageOf(contract, `${group}/${name}`);
      if (owner?.declared) continue;
      const d = owner?.deferred;
      err(
        `${group}/${name}: not declared in architecture.json — ${d ? hint(d) : "new packages require an accepted ADR."}`,
      );
    }

  // 2) Deferred dependencies must not appear anywhere (root + catalog included)
  for (const dep of Object.keys(depsOf(rootPackageJson))) {
    const d = forbidden(dep);
    if (d) err(`package.json → ${dep}: ${hint(d)}`);
  }
  for (const { dep, deferred } of deferredDepsInCatalog(contract, catalogText))
    err(`pnpm-workspace.yaml catalog → ${dep}: ${hint(deferred)}`);

  // 3) Per-package checks
  for (const [dir, spec] of Object.entries(packages)) {
    const snap = snapshot.packages[dir];
    const pj = snap?.packageJson;
    if (!pj) {
      err(`${dir}: package.json missing`);
      continue;
    }
    if (!spec.adr || spec.adr.includes("/proposed/") || !snap.adrExists)
      err(`${dir}: missing or invalid accepted ADR reference (${spec.adr ?? "-"})`);

    const expected = `${scope}/${base(dir)}`;
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
      else if (forbidden(dep)) err(`${dir} → ${dep}: ${hint(forbidden(dep))}`);
      else if (extAllow && !extAllow.has(dep) && !testAllow.has(dep))
        err(`${dir} → ${dep}: external dependency not in allow list (${[...extAllow].join(", ") || "none"})`);
    }

    for (const entry of snap.entries) {
      const r = entry.path;
      if (entry.kind === "emptyDir") {
        err(`${r}: empty folder (placeholders are forbidden)`);
        continue;
      }
      if (base(r) === ".gitkeep") err(`${r}: placeholder files are forbidden`);
      const src = entry.source;
      if (src === undefined) continue;
      if (/@ts-(ignore|nocheck)/.test(src)) err(`${r}: @ts-ignore / @ts-nocheck are forbidden`);
      if (/^\s*export\s*\{\s*\}\s*;?\s*$/.test(src)) err(`${r}: empty module (export {}) — placeholders are forbidden`);
      const isTest = /\.(test|spec)\.[cm]?[jt]sx?$/.test(r);

      for (const m of src.matchAll(IMPORT_RE)) {
        // `import type ...` or `import { type A, type B } ...` (every binding type-prefixed) is type-only.
        const named = m[3]?.trim().match(/^\{([^}]*)\}$/);
        const items = named ? named[1].split(",").map((x) => x.trim()).filter(Boolean) : [];
        const isType = Boolean(m[2]) || (items.length > 0 && items.every((x) => /^type\s/.test(x)));
        const s = m[4] ?? m[5];
        if (!s) continue;
        if (s.startsWith(".")) {
          const resolved = path.posix.join(path.posix.dirname(r), s);
          if (!resolved.startsWith(`${dir}/`)) err(`${r}: relative import outside the package ("${s}")`);
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
        if (forbidden(name)) {
          err(`${r}: "${name}": ${hint(forbidden(name))}`);
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
  if (contract.claudeBlock) {
    const h = claudeMdText === null ? null : claudeBlockHash(claudeMdText, contract.claudeBlock);
    if (!h) err("CLAUDE.md: scaffold block missing");
    else if (h !== contract.claudeBlock.sha256)
      err("CLAUDE.md: scaffold block was modified. Humans only; if intentional, write the output of `pnpm arch --claude-hash` into architecture.json > claude_md_block.sha256.");
  }
  return errors;
}
