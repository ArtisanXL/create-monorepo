import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runtime, Selection } from "../src/components.ts";
import { createAdapter, PM_NAMES } from "../src/pm/index.ts";
import { scaffold } from "../src/scaffold.ts";
import { fakeDeps, scaffoldOptions } from "./support/fixture.ts";

// Update the golden files after an intentional template/output change with: pnpm test -u
// (see test/golden/README.md). File modes are deliberately not captured (no-op on Windows).

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

/** The default Selection keeps the plain `<pm>.golden.txt` name; the others add their label. */
const GOLDEN_CASES: {
  label: string | undefined;
  selection: Selection | undefined;
  runtime?: Runtime;
}[] = [
  { label: undefined, selection: undefined },
  { label: "cloudflare", selection: undefined, runtime: "cloudflare" },
  { label: "apps-api", selection: { apps: ["api"], packages: [] } },
  { label: "apps-web", selection: { apps: ["web"], packages: [] } },
  {
    label: "cloudflare-apps-web",
    selection: { apps: ["web"], packages: [] },
    runtime: "cloudflare",
  },
  {
    label: "apps-none-domain-contracts",
    selection: { apps: [], packages: ["domain", "contracts"] },
  },
];

describe.each(PM_NAMES)("golden output: %s", (name) => {
  it.each(GOLDEN_CASES)("matches the committed golden file byte for byte ($label)", async (c) => {
    await scaffold(
      scaffoldOptions(dir, {
        ...(c.selection ? { selection: c.selection } : {}),
        ...(c.runtime ? { runtime: c.runtime } : {}),
      }),
      fakeDeps(createAdapter(name, async () => "9.9.9")),
    );
    const file = c.label ? `${name}.${c.label}.golden.txt` : `${name}.golden.txt`;
    await expect(await serialize(dir)).toMatchFileSnapshot(`golden/${file}`);
  });
});
