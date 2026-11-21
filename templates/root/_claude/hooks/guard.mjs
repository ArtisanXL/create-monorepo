#!/usr/bin/env node
// PreToolUse: blocks writes to protected files, undeclared packages, deferred dependencies and
// hook bypass attempts (exit 2 → the tool call is cancelled and the message goes to the agent).
// Thin adapter: the decision lives in scripts/guard-rules.mjs.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadContract } from "../../scripts/arch-contract.mjs";
import { decide } from "../../scripts/guard-rules.mjs";

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const claudeMd = path.join(root, "CLAUDE.md");

const result = decide({
  tool: input.tool_name,
  input: input.tool_input,
  contract: loadContract(root),
  root,
  home: process.env.HOME ?? "~",
  claudeMdText: existsSync(claudeMd) ? readFileSync(claudeMd, "utf8") : undefined,
});
if (!result.allow) {
  process.stderr.write(`⛔ ${result.message}\nRules: CLAUDE.md and architecture.json.\n`);
  process.exit(2);
}
process.exit(0);
