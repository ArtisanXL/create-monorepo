// Runs inside the supervisor's child process (guard.mjs). Exit 0 = allow, exit 2 = block with the
// message on stderr. Any other outcome (crash, signal, OOM, uncaught error) is treated as a block by the supervisor.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const deny = (message) => {
  process.stderr.write(`⛔ ${message}\nRules: CLAUDE.md and architecture.json.\n`);
  process.exit(2);
};

try {
  const { loadContract } = await import("../../scripts/arch-contract.mjs");
  const { decide } = await import("../../scripts/guard-rules.mjs");
  const input = JSON.parse(readFileSync(0, "utf8") || "{}");
  const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const claudeMd = path.join(root, "CLAUDE.md");

  const result = decide({
    tool: input.tool_name,
    input: input.tool_input,
    contract: loadContract(root),
    root,
    home: process.env.HOME ?? "~",
    platform: process.platform,
    claudeMdText: existsSync(claudeMd) ? readFileSync(claudeMd, "utf8") : undefined,
  });
  if (!result.allow) deny(result.message);
} catch (error) {
  deny(`The guard hook failed (${error instanceof Error ? error.message : String(error)}); blocking this call. Ask the user to check .claude/hooks/guard.mjs and architecture.json.`);
}
process.exit(0);
