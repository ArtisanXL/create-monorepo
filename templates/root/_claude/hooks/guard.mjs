#!/usr/bin/env node
// PreToolUse: blocks writes to protected files, undeclared packages, deferred dependencies and
// hook bypass attempts (exit 2 → the tool call is cancelled and the message goes to the agent).
// Claude Code only cancels a call on exit 2; exit 1, a signal (e.g. a segfault, 139) or hitting the
// hook timeout all let the call run. So this file is a supervisor: it runs the real decision
// (guard-worker.mjs → scripts/guard-rules.mjs) in a child Node process with a wall-clock limit and a
// heap cap, and maps every outcome except a clean exit 0 / exit 2 to a block.
// The settings.json `timeout` (seconds; command hooks default to 60 s, see
// https://code.claude.com/docs/en/hooks) must stay above LIMIT_MS so Claude Code's own timeout never fires first.
// Cost: one extra Node start per call (~40 ms), accepted so a native crash cannot fail open.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const LIMIT_MS = 10_000;
const MAX_HEAP_MB = 512;

const deny = (message) => {
  process.stderr.write(`⛔ ${message}\nRules: CLAUDE.md and architecture.json.\n`);
  process.exit(2);
};
const failed = (why) =>
  deny(`The guard hook failed (${why}); blocking this call. Ask the user to check .claude/hooks/guard.mjs and architecture.json.`);

let stdin;
try {
  stdin = readFileSync(0);
} catch (error) {
  failed(error instanceof Error ? error.message : String(error));
}

const worker = fileURLToPath(new URL("./guard-worker.mjs", import.meta.url));
const child = spawnSync(process.execPath, [`--max-old-space-size=${MAX_HEAP_MB}`, worker], {
  input: stdin,
  timeout: LIMIT_MS,
  killSignal: "SIGKILL",
  maxBuffer: 1024 * 1024,
  env: process.env,
  stdio: ["pipe", "ignore", "pipe"],
  windowsHide: true,
});

if (child.error) {
  failed(child.error.code === "ETIMEDOUT" ? `timed out after ${LIMIT_MS} ms` : child.error.message);
} else if (child.signal) {
  failed(`worker killed by ${child.signal}`);
} else if (child.status === 2) {
  process.stderr.write(child.stderr);
  process.exit(2);
} else if (child.status !== 0) {
  failed(`worker exited with code ${child.status}`);
}
process.exit(0);
