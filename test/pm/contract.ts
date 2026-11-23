import { describe, expect, it } from "vitest";
import { createAdapter, PM_NAMES, type PmName } from "../../src/pm/index.ts";
import { gather, plan, type TargetView } from "../../src/scaffold.ts";
import { catalogPackages, listTemplateFiles } from "../../src/templates.ts";

export const TOKEN_RE = /__[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*__/;

const emptyView: TargetView = { exists: () => false, read: () => "" };

/** Every package-manager adapter in the table must pass this contract. */
export function adapterContract(name: PmName) {
  describe(`package-manager adapter contract: ${name}`, () => {
    const adapter = createAdapter(name, async () => "9.9.9");

    it("is registered under its own name", () => {
      expect(adapter.name).toBe(name);
      expect(PM_NAMES).toContain(name);
    });

    it("reports its version", async () => {
      expect(await adapter.version()).toBe("9.9.9");
    });

    it("puts every catalog entry into the catalog file", async () => {
      const templates = await listTemplateFiles();
      const names = [...(await catalogPackages()), "@types/node"];
      const versions = new Map(names.map((n, i) => [n, `1.${i}.0`]));
      const g = await gather(
        { target: "/nowhere", scope: "@acme", dbPrefix: "acme", install: false, nodeMajor: 24 },
        { resolveVersion: async (p) => versions.get(p) as string, pm: adapter },
        emptyView,
      );
      const catalogText = plan(g).files.find((f) => f.path === adapter.catalogFile)?.content;
      expect(catalogText).toBeDefined();
      for (const n of names) {
        expect(catalogText).toContain(n);
        if (n !== "@types/node")
          expect(catalogText).toMatch(new RegExp(`1\\.${[...versions.keys()].indexOf(n)}\\.0`));
      }
      expect(catalogText).toContain("^24");
    });

    it("renders exactly the files it declares, none of which a template writes", async () => {
      const rendered = adapter.renderFiles({ typescript: "~5.0.0" });
      expect(Object.keys(rendered).sort()).toEqual([...adapter.files].sort());
      const dests = (await listTemplateFiles()).map((t) => t.dest);
      for (const f of adapter.files) expect(dests).not.toContain(f);
      expect([...adapter.files, ...dests]).toContain(adapter.catalogFile);
    });

    it("has well-formed commands led by the package manager", () => {
      for (const command of Object.values(adapter.commands)) {
        expect(command.length).toBeGreaterThan(0);
        expect(command.every((a) => typeof a === "string" && a.length > 0)).toBe(true);
      }
      expect(adapter.commands.run[0]).toBe(name);
    });

    it("has literal, non-empty token values", () => {
      for (const [token, value] of Object.entries(adapter.tokens)) {
        expect(value, token).not.toBe("");
        expect(value, token).not.toMatch(TOKEN_RE);
      }
    });
  });
}
