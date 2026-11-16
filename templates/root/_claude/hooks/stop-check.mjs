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
