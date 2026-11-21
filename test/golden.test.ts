import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPnpmAdapter } from "../src/pm/pnpm.ts";
import { scaffold } from "../src/scaffold.ts";
import { fakeDeps, scaffoldOptions } from "./support/fixture.ts";

// Update the golden files after an intentional template/output change with: pnpm test -u
// (see test/golden/README.md). File modes are deliberately not captured (no-op on Windows).
const GOLDEN_CASES = [{ name: "pnpm", adapter: () => createPnpmAdapter(async () => "9.9.9") }];

async function listFiles(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(root, rel), { withFileTypes: true })) {
    if (e.name === ".git") continue;
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(root, p)));
    else out.push(p);
  }
  return out.sort();
}

async function serialize(root: string): Promise<string> {
  const parts: string[] = [];
  for (const path of await listFiles(root)) {
    const content = await readFile(join(root, path), "utf8");
    parts.push(`=== ${path} (${Buffer.byteLength(content)} bytes) ===\n${content}\n`);
  }
  return parts.join("");
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "golden-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe.each(GOLDEN_CASES)("golden output: $name", ({ name, adapter }) => {
  it("matches the committed golden file byte for byte", async () => {
    await scaffold(scaffoldOptions(dir), fakeDeps(adapter()));
    await expect(await serialize(dir)).toMatchFileSnapshot(`golden/${name}.golden.txt`);
  });
});
