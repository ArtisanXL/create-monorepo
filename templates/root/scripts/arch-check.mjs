#!/usr/bin/env node
// Enforces the contract in architecture.json. Dependency-free; does not need the TS compiler API.
// Gathers a snapshot of the repo, runs the pure rules in arch-rules.mjs, prints the result.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { claudeBlockHash, contractFrom, PACKAGE_GROUPS } from "./arch-contract.mjs";
import { check } from "./arch-rules.mjs";

const root = path.resolve(import.meta.dirname, "..");
const readText = (...p) => readFileSync(path.join(root, ...p), "utf8");
const readJson = (...p) => JSON.parse(readText(...p));
const rel = (p) => path.relative(root, p).split(path.sep).join("/");

const contract = contractFrom(readJson("architecture.json"));
const claudeMdText = existsSync(path.join(root, "CLAUDE.md")) ? readText("CLAUDE.md") : null;

// A human intentionally changed the block: `pnpm arch --claude-hash` → write it into architecture.json.
if (process.argv.includes("--claude-hash")) {
  const hash = contract.claudeBlock && claudeMdText !== null ? claudeBlockHash(claudeMdText, contract.claudeBlock) : null;
  console.log(hash ?? "CLAUDE.md scaffold block not found");
  process.exit(0);
}

const SOURCE_RE = /\.(ts|tsx|mts|cts|js|mjs|jsx)$/;

/** Files and empty folders below a package, in walk order, with the source of code files. */
function entriesOf(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name === ".turbo") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (readdirSync(p).length === 0) out.push({ path: rel(p), kind: "emptyDir" });
      entriesOf(p, out);
    } else {
      out.push({ path: rel(p), kind: "file", source: SOURCE_RE.test(p) ? readFileSync(p, "utf8") : undefined });
    }
  }
  return out;
}

function gather() {
  const packages = {};
  for (const dir of Object.keys(contract.packages)) {
    const pjPath = path.join(root, dir, "package.json");
    const adr = contract.packages[dir].adr;
    packages[dir] = {
      packageJson: existsSync(pjPath) ? JSON.parse(readFileSync(pjPath, "utf8")) : null,
      adrExists: Boolean(adr) && existsSync(path.join(root, adr)),
      entries: existsSync(pjPath) ? entriesOf(path.join(root, dir)) : [],
    };
  }
  const groupDirs = {};
  for (const group of PACKAGE_GROUPS)
    groupDirs[group] = existsSync(path.join(root, group)) ? readdirSync(path.join(root, group)) : [];
  return {
    contract,
    rootPackageJson: readJson("package.json"),
    catalogText: readText("pnpm-workspace.yaml"),
    claudeMdText,
    groupDirs,
    packages,
  };
}

const errors = check(gather());
if (errors.length) {
  console.error(`✗ Architecture check failed (${errors.length}):\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  console.error("\nRules: CLAUDE.md, architecture.json, docs/adr/");
  process.exit(1);
}
console.log(`✓ Architecture check passed (${Object.keys(contract.packages).length} packages)`);
