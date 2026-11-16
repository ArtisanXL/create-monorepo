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

const ROOT_FILES = [
  ".editorconfig",
  ".env.example",
  ".gitignore",
  ".nvmrc",
  "biome.json",
  "compose.yaml",
  "package.json",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "turbo.json",
  "vitest.config.ts",
];

const WORKTREE_FILES = [
  "paseo.json",
  ".worktreeinclude",
  "scripts/worktree-lib.mjs",
  "scripts/worktree-lib.test.mjs",
  "scripts/worktree.mjs",
  "docs/adr/0004-worktree-isolation.md",
];

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "parity-"));
});
afterEach(() => rm(tmp, { recursive: true, force: true }));

describe.skipIf(!parityEnabled)("bash parity: root and worktree files", () => {
  it("TS output matches bash output for the root-file and worktree subset", async () => {
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

    expect(await diffTrees(bashDir, tsDir, [...ROOT_FILES, ...WORKTREE_FILES])).toEqual([]);
  });
});
