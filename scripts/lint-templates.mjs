#!/usr/bin/env node
// Lints the generated-file templates (templates/**/*.mjs) with Biome using the repo's lint rules,
// and checks the `@if`/`@endif` blocks of every template.
// They cannot be linted in place: templates/root/biome.json is a second root config that makes
// Biome refuse to run. So the .mjs files are copied to a scratch dir next to a lint-only config.
// Formatting is not checked: the templates stay byte-identical to what users receive.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkBlocks } from "../src/blocks.ts";

const repo = path.resolve(import.meta.dirname, "..");
const templates = path.join(repo, "templates");
const scratch = mkdtempSync(path.join(tmpdir(), "lint-templates-"));

// `@if`/`@endif` blocks: balanced, known component names (every file type).
const templateFiles = readdirSync(templates, { recursive: true, withFileTypes: true }).filter((e) =>
  e.isFile(),
);
let directiveErrors = 0;
for (const entry of templateFiles) {
  const file = path.join(entry.parentPath, entry.name);
  for (const { line, message } of checkBlocks(readFileSync(file, "utf8"))) {
    console.error(`${path.relative(repo, file)}:${line}: ${message}`);
    directiveErrors++;
  }
}

try {
  for (const entry of readdirSync(templates, { recursive: true })) {
    if (!entry.endsWith(".mjs")) continue;
    cpSync(path.join(templates, entry), path.join(scratch, entry), { recursive: true });
  }
  writeFileSync(
    path.join(scratch, "biome.json"),
    JSON.stringify({
      formatter: { enabled: false },
      assist: { enabled: false },
      linter: { enabled: true, rules: { preset: "recommended" } },
    }),
  );
  const biome = path.join(repo, "node_modules", ".bin", "biome");
  const result = spawnSync(biome, ["lint", "."], { cwd: scratch, stdio: "inherit" });
  process.exitCode = directiveErrors > 0 ? 1 : (result.status ?? 1);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
