import { describe, expect, it } from "vitest";
import type { PackageManagerAdapter } from "../../src/pm/types.ts";

/** Every package-manager adapter implementation must pass this contract. */
export function adapterContract(name: string, create: (version: string) => PackageManagerAdapter) {
  describe(`package-manager adapter contract: ${name}`, () => {
    const adapter = create("9.9.9");
    const catalog = { typescript: "~5.0.0", "@biomejs/biome": "^2.0.0" };

    it("reports its version and builds the packageManager field from it", async () => {
      expect(await adapter.version()).toBe("9.9.9");
      expect(adapter.packageManagerField("9.9.9")).toBe(`${adapter.name}@9.9.9`);
    });

    it("renders a workspace file with every catalog entry", () => {
      const text = adapter.renderWorkspaceFile(catalog);
      expect(adapter.workspaceFile).not.toBe("");
      expect(text).toContain('"typescript": "~5.0.0"');
      expect(text).toContain('"@biomejs/biome": "^2.0.0"');
    });

    it("allows install scripts only for the build allowlist (esbuild)", () => {
      expect(adapter.renderWorkspaceFile(catalog)).toMatch(/esbuild/);
    });

    it("names a lockfile", () => {
      expect(adapter.lockfile).toMatch(/lock/);
    });

    it("returns well-formed commands led by the package manager", () => {
      const commands = [
        adapter.installCommand(),
        adapter.verifyCommand(),
        adapter.execCommand(["biome", "--version"]),
        adapter.filterCommand("@acme/api", "test"),
        adapter.formatCommand(["a.json", "b.ts"]),
      ];
      for (const [cmd, ...args] of commands) {
        expect(cmd).toBe(adapter.name);
        expect(args.every((a) => typeof a === "string" && a.length > 0)).toBe(true);
      }
      expect(adapter.formatCommand(["a.json", "b.ts"]).slice(-2)).toEqual(["a.json", "b.ts"]);
    });

    it("provides next-steps text using its own run wording", () => {
      const steps = adapter.nextSteps();
      expect(steps).toContain("Next steps:");
      expect(steps).toContain(`${adapter.name} dev`);
      expect(steps).toContain("docker compose up -d");
    });
  });
}
