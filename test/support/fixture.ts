import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPnpmAdapter } from "../../src/pm/pnpm.ts";
import { type Deps, type Options, scaffold } from "../../src/scaffold.ts";

export const scaffoldOptions = (target: string, over: Partial<Options> = {}): Options => ({
  target,
  scope: "@acme",
  dbPrefix: "acme",
  pm: "pnpm",
  install: false,
  nodeMajor: 24,
  ...over,
});

export const fakeDeps = (pm: Deps["pm"] = createPnpmAdapter(async () => "9.9.9")): Deps => ({
  resolveVersion: async () => "1.2.3",
  run: async () => ({ code: 0 }),
  pm,
});

/** Scaffolds into a fresh temp dir; returns the dir and a cleanup function. */
export async function scaffoldFixture(over: Partial<Options> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "fixture-"));
  await scaffold(scaffoldOptions(dir, over), fakeDeps());
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Minimal package.json per declared package, until the packages/apps templates exist. */
export async function stubDeclaredPackages(dir: string, scope = "@acme") {
  const arch = JSON.parse(await readFile(join(dir, "architecture.json"), "utf8"));
  for (const path of Object.keys(arch.packages)) {
    await mkdir(join(dir, path), { recursive: true });
    await writeFile(
      join(dir, path, "package.json"),
      `${JSON.stringify({ name: `${scope}/${path.split("/")[1]}`, private: true })}\n`,
    );
  }
}
