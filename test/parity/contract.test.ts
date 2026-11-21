import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPnpmAdapter } from "../../src/pm/pnpm.ts";
import { scaffold } from "../../src/scaffold.ts";
import {
  createPnpmShim,
  diffTrees,
  FAKE_PM_VERSION,
  fakeVersion,
  parityEnabled,
  runBash,
} from "./harness.ts";

// CODEOWNERS, guard.mjs and arch-check.mjs diverge from the bash originals on purpose (shared arch-contract module).
const CONTRACT_FILES = [
  "architecture.json",
  "CLAUDE.md",
  ".claude/settings.json",
  ".claude/hooks/stop-check.mjs",
  ".githooks/pre-commit",
  ".github/workflows/ci.yml",
  "docs/adr/TEMPLATE.md",
  "docs/adr/0001-package-boundaries.md",
  "docs/adr/0002-deferred-packages.md",
  "docs/adr/0003-job-queue-pg-boss.md",
  "docs/adr/proposed/README.md",
];

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "parity-"));
});
afterEach(() => rm(tmp, { recursive: true, force: true }));

describe.skipIf(!parityEnabled)("bash parity: architecture contract and guards", () => {
  it("TS output matches bash output for the contract subset", async () => {
    const bashDir = join(tmp, "bash");
    const tsDir = join(tmp, "ts");
    await runBash(bashDir, await createPnpmShim());

    await scaffold(
      {
        target: tsDir,
        scope: "@acme",
        dbPrefix: "acme",
        pm: "pnpm",
        install: false,
        nodeMajor: Number(process.versions.node.split(".")[0]),
      },
      {
        resolveVersion: async (pkg) => fakeVersion(pkg),
        run: async () => ({ code: 0 }),
        pm: createPnpmAdapter(async () => FAKE_PM_VERSION),
      },
    );

    expect(await diffTrees(bashDir, tsDir, CONTRACT_FILES)).toEqual([]);
  });
});
