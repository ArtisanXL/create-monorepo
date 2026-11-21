import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAdapter, PM_NAMES } from "../src/pm/index.ts";
import { ADAPTER_TOKENS } from "../src/pm/types.ts";
import { CORE_TOKENS, gather, plan, type TargetView } from "../src/scaffold.ts";
import { listTemplateFiles, TEMPLATES_DIR } from "../src/templates.ts";
import { TOKEN_RE } from "./pm/contract.ts";

const TOKEN_G = new RegExp(TOKEN_RE.source, "g");
const KNOWN = new Set<string>([...CORE_TOKENS, ...ADAPTER_TOKENS]);

const allTemplates = async () => [
  ...(await listTemplateFiles()),
  {
    src: "claude-md/block.md",
    dest: "claude-md/block.md",
    text: await readFile(join(TEMPLATES_DIR, "claude-md", "block.md"), "utf8"),
  },
];

const GUARD_RULES = "root/scripts/guard-rules.mjs";
const GUARD_ALLOWED = new Set([
  '    for (const pm of ["pnpm", "npm", "yarn", "bun"].filter((x) => x !== chosenPm)) {',
  "  // Flags and their values may sit between the PM and the verb (`pnpm --filter x add`, `pnpm -w add`).",
  "  if (/\\b(pnpm|npm|yarn|bun)\\b[^|;&\\n]*\\s(add|install|i|update|up)\\b/.test(cmd)) {",
]);

describe("templates are package-manager neutral", () => {
  it("only use tokens that some component defines", async () => {
    for (const t of await allTemplates()) {
      for (const token of t.text.match(TOKEN_G) ?? [])
        expect(KNOWN.has(token), `${t.src}: ${token}`).toBe(true);
    }
  });

  it("do not spell out pnpm outside the guard's block list", async () => {
    for (const t of await allTemplates()) {
      for (const line of t.text.split("\n")) {
        if (!/\bpnpm\b|frozen-lockfile|corepack enable/.test(line)) continue;
        expect(t.src === GUARD_RULES && GUARD_ALLOWED.has(line), `${t.src}: ${line}`).toBe(true);
      }
    }
  });

  it("arch-check does not hardcode the catalog file", async () => {
    const text = await readFile(join(TEMPLATES_DIR, "root/scripts/arch-check.mjs"), "utf8");
    expect(text).not.toContain("pnpm-workspace.yaml");
  });

  it.each(PM_NAMES)("leave no token unfilled with %s", async (name) => {
    const view: TargetView = { exists: () => false, read: () => "" };
    const g = await gather(
      { target: "/nowhere", scope: "@acme", dbPrefix: "acme", install: false, nodeMajor: 24 },
      { resolveVersion: async () => "1.2.3", pm: createAdapter(name, async () => "9.9.9") },
      view,
    );
    for (const f of plan(g).files) expect(f.content, f.path).not.toMatch(TOKEN_RE);
  });
});
