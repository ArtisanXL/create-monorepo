import { describe, expect, it } from "vitest";
import { check, type Snapshot } from "../templates/root/scripts/arch-rules.mjs";
import { CLAUDE_MD, templateContract } from "./support/contract.ts";

const contract = templateContract();

/** A snapshot of a healthy repo: every declared package present, nothing else. */
function healthy(): Snapshot {
  const packages: Snapshot["packages"] = {};
  for (const dir of Object.keys(contract.packages))
    packages[dir] = {
      packageJson: { name: `@acme/${dir.split("/")[1]}` },
      adrExists: true,
      entries: [],
    };
  return {
    contract,
    rootPackageJson: { devDependencies: { typescript: "^6" } },
    catalogText: "catalog:\n  zod: ^4\n",
    claudeMdText: CLAUDE_MD,
    groupDirs: {
      apps: ["api", "web", "worker"],
      packages: ["contracts", "core", "db", "domain"],
    },
    packages,
  };
}

function withFile(snap: Snapshot, dir: string, file: string, source: string) {
  snap.packages[dir]?.entries.push({ path: `${dir}/${file}`, kind: "file", source });
  return snap;
}

describe("arch-check rules", () => {
  it("passes on a healthy snapshot", () => {
    expect(check(healthy())).toEqual([]);
  });

  it("reports an undeclared package folder", () => {
    const snap = healthy();
    snap.groupDirs.packages?.push("auth", "widgets");
    const errors = check(snap);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain(
      'packages/auth: not declared in architecture.json — This is deferred "auth"',
    );
    expect(errors[1]).toContain("packages/widgets: not declared");
    expect(errors[1]).toContain("new packages require an accepted ADR.");
  });

  it("requires type-only imports where the contract says type_only", () => {
    const run = (src: string) => check(withFile(healthy(), "apps/web", "src/a.ts", src));
    expect(run('import type { AppType } from "@acme/api";\n')).toEqual([]);
    expect(run('import { type AppType } from "@acme/api";\nexport type A = AppType;\n')).toEqual(
      [],
    );
    expect(run('import { type AppType, app } from "@acme/api";\n')).toEqual([
      'apps/web/src/a.ts: "@acme/api" may only be imported with `import type`',
    ]);
  });

  it("rejects imports a package may not make", () => {
    const snap = withFile(
      healthy(),
      "packages/domain",
      "src/a.ts",
      'import { db } from "@acme/db";\nimport x from "left-pad";\n',
    );
    expect(check(snap)).toEqual([
      'packages/domain/src/a.ts: import of "@acme/db" is not allowed',
      expect.stringContaining('import of "left-pad" is not allowed'),
    ]);
  });

  it("rejects relative imports that leave the package and self-imports by name", () => {
    const snap = withFile(
      healthy(),
      "packages/domain",
      "src/a.ts",
      'import a from "../../core/src/x";\nimport b from "./b";\nimport c from "@acme/domain";\n',
    );
    expect(check(snap)).toEqual([
      'packages/domain/src/a.ts: relative import outside the package ("../../core/src/x")',
      'packages/domain/src/a.ts: a package must not import itself by name ("@acme/domain")',
    ]);
  });

  it("allows test-only externals in test files only", () => {
    const snap = healthy();
    snap.packages["packages/domain"]?.entries.push(
      {
        path: "packages/domain/src/a.test.ts",
        kind: "file",
        source: 'import { it } from "vitest";\n',
      },
      { path: "packages/domain/src/a.ts", kind: "file", source: 'import { it } from "vitest";\n' },
    );
    expect(check(snap)).toEqual([
      expect.stringContaining('packages/domain/src/a.ts: import of "vitest"'),
    ]);
  });

  it("rejects placeholders and suppressions", () => {
    const snap = healthy();
    snap.packages["packages/domain"]?.entries.push(
      { path: "packages/domain/empty", kind: "emptyDir" },
      { path: "packages/domain/.gitkeep", kind: "file" },
      { path: "packages/domain/src/a.ts", kind: "file", source: "// @ts-ignore\n" },
      { path: "packages/domain/src/b.ts", kind: "file", source: "export {};" },
    );
    expect(check(snap)).toEqual([
      "packages/domain/empty: empty folder (placeholders are forbidden)",
      "packages/domain/.gitkeep: placeholder files are forbidden",
      "packages/domain/src/a.ts: @ts-ignore / @ts-nocheck are forbidden",
      "packages/domain/src/b.ts: empty module (export {}) — placeholders are forbidden",
    ]);
  });

  it("rejects deferred dependencies in root, catalog, package.json and imports", () => {
    const snap = withFile(
      healthy(),
      "packages/domain",
      "src/a.ts",
      'import { x } from "better-auth/client";\n',
    );
    snap.rootPackageJson = { dependencies: { "better-auth": "1" } };
    snap.catalogText = "catalog:\n  zod: ^4\n  better-auth: ^1\n";
    snap.packages["packages/db"] = {
      ...snap.packages["packages/db"],
      packageJson: { name: "@acme/db", dependencies: { lucia: "1" } },
    } as never;
    const errors = check(snap);
    expect(errors).toEqual([
      expect.stringContaining('package.json → better-auth: This is deferred "auth"'),
      expect.stringContaining('pnpm-workspace.yaml catalog → better-auth: This is deferred "auth"'),
      expect.stringContaining('packages/domain/src/a.ts: "better-auth": This is deferred "auth"'),
      expect.stringContaining('packages/db → lucia: This is deferred "auth"'),
    ]);
  });

  it("checks package.json presence, name, ADR and workspace dependencies", () => {
    const snap = healthy();
    snap.packages["apps/web"] = { packageJson: null, adrExists: true, entries: [] };
    snap.packages["packages/domain"] = {
      packageJson: {
        name: "wrong",
        dependencies: { "@acme/core": "workspace:*", "@acme/nope": "1" },
      },
      adrExists: false,
      entries: [],
    };
    expect(check(snap)).toEqual([
      "packages/domain: missing or invalid accepted ADR reference (docs/adr/0001-package-boundaries.md)",
      'packages/domain: package name must be "@acme/domain" (found: wrong)',
      "packages/domain → @acme/core: dependency not allowed (allowed: none)",
      "packages/domain → @acme/nope: unknown workspace package",
      "apps/web: package.json missing",
    ]);
  });

  describe("CLAUDE.md block", () => {
    it("reports a modified block", () => {
      const snap = healthy();
      snap.claudeMdText = CLAUDE_MD.replace("# Project rules", "# Changed rules");
      expect(check(snap)).toEqual([expect.stringContaining("scaffold block was modified")]);
    });

    it("ignores changes outside the block and accepts CRLF", () => {
      const snap = healthy();
      snap.claudeMdText = CLAUDE_MD.replace("after", "changed").replaceAll("\n", "\r\n");
      expect(check(snap)).toEqual([]);
    });

    it("reports a missing block or file", () => {
      const snap = healthy();
      snap.claudeMdText = "# nothing\n";
      expect(check(snap)).toEqual(["CLAUDE.md: scaffold block missing"]);
      snap.claudeMdText = null;
      expect(check(snap)).toEqual(["CLAUDE.md: scaffold block missing"]);
    });
  });
});
