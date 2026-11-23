import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { checkBlocks } from "../src/blocks.ts";
import { catalogPackages, listTemplateFiles, TEMPLATES_DIR } from "../src/templates.ts";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function fixtureTree(files: Record<string, string>): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "templates-"));
  for (const t of ["root", "packages", "apps"]) await mkdir(join(dir, t), { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return dir;
}

describe("catalogPackages", () => {
  it("collects distinct catalog: dependencies from every dependency field, sorted", async () => {
    const d = await fixtureTree({
      "root/package.json": JSON.stringify({
        devDependencies: { zod: "catalog:", vitest: "^1.0.0" },
        optionalDependencies: { fsevents: "catalog:" },
      }),
      "packages/a/package.json": JSON.stringify({
        dependencies: { zod: "catalog:", hono: "catalog:" },
        peerDependencies: { react: "catalog:" },
      }),
    });
    expect(await catalogPackages(d)).toEqual(["fsevents", "hono", "react", "zod"]);
  });

  it("picks up a new catalog: dependency without code changes", async () => {
    const d = await fixtureTree({
      "apps/x/package.json": '{"dependencies":{"newpkg":"catalog:"}}',
    });
    expect(await catalogPackages(d)).toContain("newpkg");
  });

  it("covers the real templates, including @types/node", async () => {
    const pkgs = await catalogPackages();
    expect(pkgs).toEqual([...pkgs].sort());
    expect(pkgs).toEqual(expect.arrayContaining(["typescript", "zod", "@types/node"]));
  });
});

describe("listTemplateFiles", () => {
  it("derives destinations and executability from the tree", async () => {
    const d = await fixtureTree({
      "root/_gitignore": "node_modules\n",
      "root/scripts/run.mjs": "#!/usr/bin/env node\n",
      "apps/api/package.json": "{}",
    });
    expect(await listTemplateFiles(d)).toEqual([
      { src: "root/_gitignore", dest: ".gitignore", text: "node_modules\n", executable: false },
      {
        src: "root/scripts/run.mjs",
        dest: "scripts/run.mjs",
        text: "#!/usr/bin/env node\n",
        executable: true,
      },
      {
        src: "apps/api/package.json",
        dest: "apps/api/package.json",
        text: "{}",
        executable: false,
      },
    ]);
  });

  it("marks exactly the known shebang templates executable", async () => {
    const exec = (await listTemplateFiles()).filter((f) => f.executable).map((f) => f.dest);
    expect(exec.sort()).toEqual([
      ".claude/hooks/guard.mjs",
      ".claude/hooks/stop-check.mjs",
      ".githooks/pre-commit",
      "scripts/arch-check.mjs",
      "scripts/worktree.mjs",
    ]);
  });
});

describe("conditional blocks in the real templates", () => {
  it("are balanced and name only known components, in every template", async () => {
    const files = [
      ...(await listTemplateFiles()),
      {
        dest: "claude-md/block.md",
        text: await readFile(`${TEMPLATES_DIR}claude-md/block.md`, "utf8"),
      },
    ];
    for (const f of files) expect(checkBlocks(f.text), f.dest).toEqual([]);
  });

  it("keep root/package.json out of tools that read it as a package scope (.tmpl)", async () => {
    const dests = (await listTemplateFiles()).map((f) => f.dest);
    expect(dests).toContain("package.json");
    expect((await listTemplateFiles()).find((f) => f.dest === "package.json")?.src).toBe(
      "root/package.json.tmpl",
    );
  });
});
