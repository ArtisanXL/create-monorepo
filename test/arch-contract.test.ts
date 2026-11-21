import { describe, expect, it } from "vitest";
import {
  claudeBlockHash,
  claudeBlockSpan,
  contractFrom,
  deferredDepInCommand,
  deferredDepsInCatalog,
  deferredHint,
  deferredOfDep,
  isProtected,
  isProtectedOrDir,
  packageOf,
} from "../templates/root/scripts/arch-contract.mjs";

const contract = contractFrom({
  scope: "@acme",
  packages: { "apps/api": {}, "packages/domain": {} },
  deferred: [
    {
      name: "auth",
      path: "packages/auth",
      trigger: "When sign-in is needed.",
      deps: ["better-auth", "@auth/core"],
    },
  ],
  protected_paths: ["architecture.json", "docs/adr/", "scripts/"],
  agent_writable_exceptions: ["docs/adr/proposed/"],
  package_manager: "pnpm",
});

describe("contractFrom", () => {
  it("applies defaults for missing sections", () => {
    const c = contractFrom({});
    expect(c).toMatchObject({
      packages: {},
      deferred: [],
      protectedPaths: [],
      exceptions: [],
      testAllow: [],
      claudeBlock: undefined,
    });
  });
});

describe("protected paths", () => {
  it("matches exact files and folder prefixes", () => {
    expect(isProtected(contract, "architecture.json")).toBe(true);
    expect(isProtected(contract, "architecture.json.bak")).toBe(false);
    expect(isProtected(contract, "docs/adr/0001-x.md")).toBe(true);
    expect(isProtected(contract, "scripts/arch-contract.mjs")).toBe(true);
    expect(isProtected(contract, "packages/domain/src/a.ts")).toBe(false);
  });

  it("lets exceptions win over a protected prefix", () => {
    expect(isProtected(contract, "docs/adr/proposed/0004-x.md")).toBe(false);
  });

  it("treats the protected folder itself as protected only in the OrDir variant", () => {
    expect(isProtected(contract, "docs/adr")).toBe(false);
    expect(isProtectedOrDir(contract, "docs/adr")).toBe(true);
  });
});

describe("packageOf", () => {
  it("reports declared, undeclared and deferred folders", () => {
    expect(packageOf(contract, "apps/api/src/a.ts")).toEqual({
      dir: "apps/api",
      declared: true,
      deferred: undefined,
    });
    expect(packageOf(contract, "packages/widgets/a.ts")).toMatchObject({ declared: false });
    expect(packageOf(contract, "packages/auth/a.ts")).toMatchObject({
      declared: false,
      deferred: { name: "auth" },
    });
  });

  it("returns null outside apps/ and packages/", () => {
    expect(packageOf(contract, "scripts/a.mjs")).toBeNull();
    expect(packageOf(contract, "packages")).toBeNull();
  });
});

describe("deferred dependencies", () => {
  it("finds a dependency in a command, with or without a version", () => {
    expect(deferredDepInCommand(contract, "pnpm add better-auth")?.dep).toBe("better-auth");
    expect(deferredDepInCommand(contract, "pnpm add better-auth@1.2.3 -w")?.dep).toBe(
      "better-auth",
    );
    expect(deferredDepInCommand(contract, 'pnpm add "@auth/core@2"')?.dep).toBe("@auth/core");
  });

  it("does not match a longer name or an unrelated command", () => {
    expect(deferredDepInCommand(contract, "pnpm add better-auth-ui")).toBeUndefined();
    expect(deferredDepInCommand(contract, "pnpm add zod")).toBeUndefined();
  });

  it("escapes regex metacharacters in dependency names", () => {
    const c = contractFrom({ deferred: [{ name: "x", deps: ["a.b"] }] });
    expect(deferredDepInCommand(c, "pnpm add aXb")).toBeUndefined();
    expect(deferredDepInCommand(c, "pnpm add a.b")?.dep).toBe("a.b");
  });

  it("looks a dependency up by name and finds catalog keys", () => {
    expect(deferredOfDep(contract, "better-auth")?.name).toBe("auth");
    expect(deferredOfDep(contract, "zod")).toBeUndefined();
    const ws = 'catalog:\n  zod: ^4\n  "@auth/core": ^1\n  better-auth: ^1\n';
    expect(deferredDepsInCatalog(contract, ws).map((f) => f.dep)).toEqual([
      "better-auth",
      "@auth/core",
    ]);
  });

  it("words the hint in one place", () => {
    expect(deferredHint(contract.deferred[0] as never)).toBe(
      'This is deferred "auth" (trigger: When sign-in is needed.). If you think it is needed, stop, write an ADR draft under docs/adr/proposed/ and ask the user.',
    );
  });
});

describe("CLAUDE.md block", () => {
  const body = "<!-- scaffold:begin — x -->\n# Rules\nline\n<!-- scaffold:end -->";
  const lf = `# Mine\n\n${body}\n\nafter\n`;
  const crlf = lf.replaceAll("\n", "\r\n");

  it("returns the span in the caller's own text", () => {
    const span = claudeBlockSpan(lf);
    expect(lf.slice(span?.start, span?.end)).toBe(body);
    const spanCrlf = claudeBlockSpan(crlf);
    expect(crlf.slice(spanCrlf?.start, spanCrlf?.end)).toBe(body.replaceAll("\n", "\r\n"));
  });

  it("is null without both markers", () => {
    expect(claudeBlockSpan("nothing")).toBeNull();
    expect(claudeBlockSpan("<!-- scaffold:begin\nno end")).toBeNull();
  });

  it("hashes LF and CRLF text identically", () => {
    expect(claudeBlockHash(lf)).toMatch(/^[0-9a-f]{64}$/);
    expect(claudeBlockHash(crlf)).toBe(claudeBlockHash(lf));
    expect(claudeBlockHash("nothing")).toBeNull();
  });

  it("changes the hash when the block changes, not when the outside changes", () => {
    expect(claudeBlockHash(lf.replace("# Rules", "# Other"))).not.toBe(claudeBlockHash(lf));
    expect(claudeBlockHash(lf.replace("after", "changed"))).toBe(claudeBlockHash(lf));
  });

  it("honours custom markers", () => {
    const m = { begin: "[[", end: "]]" };
    expect(claudeBlockSpan("a [[ b ]] c", m)).toEqual({ start: 2, end: 9 });
  });
});
