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

const WORKSPACE_FILES = [
  "apps/api/package.json",
  "apps/api/src/app.test.ts",
  "apps/api/src/app.ts",
  "apps/api/src/env.ts",
  "apps/api/src/index.ts",
  "apps/api/src/server.ts",
  "apps/api/tsconfig.json",
  "apps/api/tsdown.config.ts",
  "apps/web/index.html",
  "apps/web/package.json",
  "apps/web/src/lib/api.ts",
  "apps/web/src/main.tsx",
  "apps/web/tsconfig.json",
  "apps/web/vite.config.ts",
  "apps/worker/package.json",
  "apps/worker/src/env.ts",
  "apps/worker/src/index.ts",
  "apps/worker/src/jobs/healthcheck.ts",
  "apps/worker/src/jobs/index.ts",
  "apps/worker/src/worker.ts",
  "apps/worker/tsconfig.json",
  "apps/worker/tsdown.config.ts",
  "packages/contracts/package.json",
  "packages/contracts/src/index.ts",
  "packages/contracts/tsconfig.json",
  "packages/core/package.json",
  "packages/core/src/index.ts",
  "packages/core/src/queries/format-price.ts",
  "packages/core/src/queries/health.ts",
  "packages/core/tsconfig.json",
  "packages/db/drizzle.config.ts",
  "packages/db/package.json",
  "packages/db/src/index.ts",
  "packages/db/src/schema/index.ts",
  "packages/db/tsconfig.json",
  "packages/domain/package.json",
  "packages/domain/src/index.ts",
  "packages/domain/src/money/money.test.ts",
  "packages/domain/src/money/money.ts",
  "packages/domain/tsconfig.json",
];

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "parity-"));
});
afterEach(() => rm(tmp, { recursive: true, force: true }));

describe.skipIf(!parityEnabled)("bash parity: root, packages and apps", () => {
  it("TS output matches bash output for the root, packages and apps subset", async () => {
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

    expect(await diffTrees(bashDir, tsDir, [...ROOT_FILES, ...WORKSPACE_FILES])).toEqual([]);
  });
});
