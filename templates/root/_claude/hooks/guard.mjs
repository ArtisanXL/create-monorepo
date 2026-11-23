#!/usr/bin/env node
// PreToolUse: blocks writes to protected files, undeclared packages, deferred dependencies and
// hook bypass attempts (exit 2 → the tool call is cancelled and the message goes to the agent).
// Claude Code only cancels a PreToolUse call on exit 2: by default a timed-out hook does not block
// and any other exit code (1, a signal such as a segfault's 139) is a non-blocking error.
// Two layers keep this failing closed (https://code.claude.com/docs/en/hooks):
//  1. settings.json sets `"onFailure": "block"` (Claude Code v2.1.295+), so timeouts and other
//     exit codes block, plus an explicit `timeout` (seconds; command hooks default to 600) above LIMIT_MS.
//     The hook uses the documented exec form (`command: "node"` + `args`, no shell) so it also runs on
//     Windows without Git Bash, where `$CLAUDE_PROJECT_DIR` is not expanded.
//     Requires Claude Code v2.1.295+: hook `args` (exec form) arrived in v2.1.139, and older versions
//     ignore it, run a bare `node` (exit 1, non-blocking) and fail open. `onFailure` arrived in v2.1.295;
//     whether v2.1.139-2.1.294 ignore that unknown key is unverified (believed ignored).
//  2. This file is a supervisor for older versions and for a clear message: it runs the real decision
//     (guard-worker.mjs → scripts/guard-rules.mjs) in a child Node process with a wall-clock limit and a
//     heap cap, and maps every outcome except a clean exit 0 / exit 2 to a block.
// Cost of layer 2: one extra Node start per call (~40 ms), accepted so a native crash cannot fail open.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_LIMIT_MS = 10_000;
// GUARD_TIMEOUT_MS may only lower the limit (stricter), never raise it.
const requested = Number(process.env.GUARD_TIMEOUT_MS);
const LIMIT_MS =
  Number.isInteger(requested) && requested > 0 && requested < DEFAULT_LIMIT_MS ? requested : DEFAULT_LIMIT_MS;
const MAX_HEAP_MB = 512;

const block = (message) => `⛔ ${message}\nRules: CLAUDE.md and architecture.json.\n`;
const failed = (why) =>
  block(`The guard hook failed (${why}); blocking this call. Ask the user to check .claude/hooks/guard.mjs and architecture.json.`);

// Returns the stderr text for a block (exit 2) or null to allow. The caller sets process.exitCode and
// lets the process end naturally: process.exit() can truncate a long message on a piped stderr.
function supervise() {
  let stdin;
  try {
    stdin = readFileSync(0);
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
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
    return failed(child.error.code === "ETIMEDOUT" ? `timed out after ${LIMIT_MS} ms` : child.error.message);
  }
  if (child.signal) return failed(`worker killed by ${child.signal}`);
  if (child.status === 2) {
    const message = child.stderr.toString();
    return message.trim() ? message : failed("worker blocked the call without giving a reason");
  }
  if (child.status !== 0) return failed(`worker exited with code ${child.status}`);
  return null;
}

const blocked = supervise();
if (blocked !== null) {
  process.stderr.write(blocked);
  process.exitCode = 2;
}
