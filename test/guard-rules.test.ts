import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decide } from "../templates/root/scripts/guard-rules.mjs";
import { CLAUDE_MD, templateContract } from "./support/contract.ts";

const root = join("/", "proj");
const contract = templateContract();
const abs = (p: string) => join(root, p);

function guard(tool: string, input: Record<string, unknown>, text: string | undefined = CLAUDE_MD) {
  return decide({ tool, input, contract, root, home: "/home/u", claudeMdText: text });
}
const bash = (command: string) => guard("Bash", { command });
const write = (file_path: string) => guard("Write", { file_path, content: "x" });
const blocked = (r: ReturnType<typeof decide>) => (r.allow ? undefined : r.message);

describe("guard decision: file tools", () => {
  it.each([
    "architecture.json",
    "docs/adr/0001-x.md",
    "biome.json",
    ".githooks/pre-commit",
    "scripts/arch-contract.mjs",
  ])("blocks a write to protected %s", (p) => {
    expect(blocked(write(p))).toContain("is protected; only humans may change it.");
  });

  it("allows the ADR proposal folder and ordinary files", () => {
    expect(write("docs/adr/proposed/0004-x.md")).toEqual({ allow: true });
    expect(write("packages/domain/src/money.ts")).toEqual({ allow: true });
  });

  it("accepts absolute paths and ignores paths outside the project", () => {
    expect(blocked(write(abs("architecture.json")))).toContain("protected");
    expect(write("/etc/hosts")).toEqual({ allow: true });
    expect(write("../elsewhere/architecture.json")).toEqual({ allow: true });
  });

  it("blocks undeclared and deferred packages", () => {
    expect(blocked(write("packages/widgets/index.ts"))).toContain("not a package declared");
    const deferred = blocked(write("packages/auth/index.ts"));
    expect(deferred).toContain('deferred "auth"');
    expect(deferred).toContain("docs/adr/proposed/");
  });

  it("checks NotebookEdit via notebook_path", () => {
    expect(blocked(guard("NotebookEdit", { notebook_path: "architecture.json" }))).toContain(
      "protected",
    );
  });

  it("allows tools it does not know about", () => {
    expect(guard("Read", { file_path: "architecture.json" })).toEqual({ allow: true });
  });
});

describe("guard decision: CLAUDE.md block", () => {
  const edit = (old_string: string, text?: string) =>
    guard("Edit", { file_path: abs("CLAUDE.md"), old_string, new_string: "x" }, text);
  const MSG = "The scaffold block in CLAUDE.md is protected; edit only outside the block.";

  it("blocks edits inside the block but not outside it", () => {
    expect(blocked(edit("# Project rules"))).toBe(MSG);
    expect(edit("# Mine")).toEqual({ allow: true });
    expect(edit("after")).toEqual({ allow: true });
  });

  it("blocks an edit that overlaps the block boundary", () => {
    expect(blocked(edit("# Mine\n\n<!-- scaffold:begin"))).toBe(MSG);
  });

  it("checks every MultiEdit entry", () => {
    const edits = (...olds: string[]) => ({
      file_path: "CLAUDE.md",
      edits: olds.map((old_string) => ({ old_string, new_string: "x" })),
    });
    expect(guard("MultiEdit", edits("# Mine", "after"))).toEqual({ allow: true });
    expect(blocked(guard("MultiEdit", edits("# Mine", "# Project rules")))).toBe(MSG);
  });

  it("allows a Write that keeps the block and blocks one that drops it", () => {
    expect(guard("Write", { file_path: "CLAUDE.md", content: `before\n${CLAUDE_MD}` })).toEqual({
      allow: true,
    });
    expect(blocked(guard("Write", { file_path: "CLAUDE.md", content: "# Mine\n" }))).toBe(MSG);
  });

  it("does not guard CLAUDE.md when it is missing or has no block", () => {
    expect(edit("x", undefined)).toEqual({ allow: true });
    expect(edit("x", "# no block here\n")).toEqual({ allow: true });
  });

  describe("with CRLF line endings", () => {
    const crlf = CLAUDE_MD.replaceAll("\n", "\r\n");

    it("blocks an Edit inside the block and allows one outside it", () => {
      expect(blocked(edit("# Project rules", crlf))).toBe(MSG);
      expect(blocked(edit("# Project rules\r\nbody", crlf))).toBe(MSG);
      expect(edit("# Mine", crlf)).toEqual({ allow: true });
      expect(edit("after", crlf)).toEqual({ allow: true });
    });

    it("treats an LF multi-line old_string like the same edit on an LF file", () => {
      expect(blocked(edit("# Project rules\nbody", crlf))).toBe(MSG);
      expect(blocked(edit("# Mine\n\n<!-- scaffold:begin", crlf))).toBe(MSG);
      expect(blocked(edit("<!-- scaffold:end -->\n\nafter", crlf))).toBe(MSG);
      expect(edit("\n\nafter\n", crlf)).toEqual({ allow: true });
    });
  });
});

describe("guard decision: Bash", () => {
  it("blocks installing deferred dependencies, with and without flags", () => {
    for (const cmd of [
      "pnpm add better-auth --filter @acme/core",
      "pnpm --filter @acme/core add better-auth",
      "pnpm -w add better-auth",
      "pnpm -F @acme/core install better-auth@1.0.0",
    ])
      expect(blocked(bash(cmd)), cmd).toContain('"better-auth" cannot be installed');
    expect(bash("pnpm add zod --filter @acme/contracts")).toEqual({ allow: true });
  });

  it("blocks foreign package managers behind prefixes and in install form", () => {
    for (const cmd of [
      "  npm install foo",
      "sudo npm install",
      "time npm i",
      "env X=1 yarn add zod",
      "corepack npm install",
      "npm install",
      "npm i left-pad",
      "npm ci",
      "yarn",
      "yarn add zod",
      "bun install",
      "bun add zod",
      "cd apps/api && npm install",
    ])
      expect(blocked(bash(cmd)), cmd).toContain("This project uses pnpm");
  });

  it("allows the chosen package manager and non-install foreign commands", () => {
    for (const cmd of [
      "pnpm install",
      "pnpm add zod --filter @acme/contracts",
      "pnpm verify",
      "npm --version",
      "git commit -m 'npm install notes'",
    ])
      expect(bash(cmd), cmd).toEqual({ allow: true });
  });

  it("follows the package manager recorded in the contract", () => {
    const yarn = templateContract({ packageManager: "yarn" });
    const run = (command: string) =>
      decide({ tool: "Bash", input: { command }, contract: yarn, root });
    expect(run("pnpm install").allow).toBe(false);
    expect(run("yarn install").allow).toBe(true);
  });

  it("blocks --no-verify and git commit -n", () => {
    expect(blocked(bash("git commit --no-verify -m x"))).toContain("--no-verify");
    expect(blocked(bash("git commit -n -m x"))).toContain("--no-verify");
    expect(bash("git commit -m x")).toEqual({ allow: true });
  });

  it("blocks changing the hooks path except to .githooks", () => {
    expect(blocked(bash("git config core.hooksPath /tmp/x"))).toContain("hooks path");
    expect(bash("git config core.hooksPath .githooks")).toEqual({ allow: true });
  });

  it("blocks git commands that touch protected paths", () => {
    for (const cmd of [
      "git restore architecture.json",
      "git checkout -- architecture.json",
      "git checkout HEAD -- docs/adr/0001-x.md",
      "git checkout main architecture.json",
      "git checkout --ours architecture.json",
      "git checkout --theirs architecture.json",
      "git checkout --force architecture.json",
      "git checkout --patch architecture.json",
      "git checkout --orphan x architecture.json",
    ])
      expect(blocked(bash(cmd)), cmd).toContain("via git");
    // CLAUDE.md itself is not a protected path (only its scaffold block is).
    expect(bash("git checkout -- CLAUDE.md")).toEqual({ allow: true });
    expect(bash("git checkout -- src/x.ts")).toEqual({ allow: true });
    expect(bash("git checkout main")).toEqual({ allow: true });
    expect(bash("git restore packages/domain/src/a.ts")).toEqual({ allow: true });
  });

  it("only treats a redirect target as a write", () => {
    expect(bash("cat architecture.json > /tmp/arch-copy")).toEqual({ allow: true });
    expect(bash("cat biome.json | wc -l > /dev/null")).toEqual({ allow: true });
    expect(bash("cat x > /dev/null")).toEqual({ allow: true });
    expect(blocked(bash("echo x > architecture.json"))).toContain("protected path");
    expect(blocked(bash("echo x >> docs/adr/0001-x.md"))).toContain("protected path");
    expect(blocked(bash("echo x > packages/widgets/a.ts"))).toContain("not a package declared");
  });

  it("sees a redirect to a protected file after 2>&1", () => {
    expect(blocked(bash("cmd 2>&1 > architecture.json"))).toContain("protected path");
  });

  it("blocks write commands that touch protected paths or undeclared packages", () => {
    expect(blocked(bash("rm architecture.json"))).toContain("protected path");
    expect(blocked(bash("mkdir packages/widgets"))).toContain("not a package declared");
    expect(bash("mkdir packages/domain/src/x")).toEqual({ allow: true });
  });

  it("resolves ~/ against the given home", () => {
    expect(bash("rm ~/other/architecture.json")).toEqual({ allow: true });
    const inside = decide({
      tool: "Bash",
      input: { command: "rm ~/architecture.json" },
      contract,
      root: "/home/u",
      home: "/home/u",
    });
    expect(blocked(inside)).toContain("protected path");
  });

  describe("CLAUDE.md via Bash", () => {
    it.each([
      "sed -i s/a/b/ CLAUDE.md",
      "rm CLAUDE.md",
      "echo x > CLAUDE.md",
      "echo x | tee CLAUDE.md",
    ])("blocks %s", (cmd) => {
      expect(blocked(bash(cmd))).toContain("CLAUDE.md must not be modified via Bash");
    });

    it("allows reading it, appending with tee -a, and appending-style redirects of other files", () => {
      expect(bash("cat CLAUDE.md")).toEqual({ allow: true });
      expect(bash("echo x | tee -a CLAUDE.md")).toEqual({ allow: true });
    });
  });
});

describe("guard decision: bypass hardening (#29)", () => {
  const PROTECTED = "protected path";

  it("blocks rm/mv of a parent folder of protected paths", () => {
    for (const cmd of [
      "rm -rf docs",
      "rm -r scripts/",
      "rm -rf ./docs",
      "mv docs x",
      "mv scripts /tmp/s",
      "rm -rf .",
      "git rm -r docs",
    ])
      expect(blocked(bash(cmd)), cmd).toBeDefined();
    expect(blocked(bash("rm -rf docs"))).toContain("protected paths");
  });

  it("allows harmless rm/mv, including moving into a parent folder", () => {
    for (const cmd of [
      "rm -rf node_modules",
      "rm -rf docs/old",
      "rm -rf dist build",
      "mv foo.txt docs",
      "mv a.txt .",
      "rm -rf packages/domain/dist",
    ])
      expect(bash(cmd), cmd).toEqual({ allow: true });
  });

  it("blocks git -C forms and git checkout <rev> <path>", () => {
    for (const cmd of [
      "git -C . restore architecture.json",
      "git -C . checkout HEAD -- architecture.json",
      "git -c core.x=1 -C . restore scripts/guard-rules.mjs",
      "git -C docs/adr checkout .",
      "git -C docs restore adr/0001-x.md",
      "git checkout HEAD~1 scripts/guard-rules.mjs",
      "git checkout main docs",
    ])
      expect(blocked(bash(cmd)), cmd).toContain("via git");
    expect(bash("git -C . status")).toEqual({ allow: true });
    expect(bash("git -C packages/domain checkout main")).toEqual({ allow: true });
    expect(bash("git checkout main")).toEqual({ allow: true });
  });

  it("checks the command inside bash -c / sh -c / eval", () => {
    for (const cmd of [
      'bash -c "npm install"',
      "sh -c 'npm install left-pad'",
      'bash -lc "yarn add zod"',
      'zsh -c "cd apps/api && npm ci"',
      'bash -c "bash -c \\"npm install\\""',
      'eval "npm install"',
    ])
      expect(blocked(bash(cmd)), cmd).toContain("This project uses pnpm");
    expect(blocked(bash('bash -c "rm architecture.json"'))).toContain(PROTECTED);
    expect(blocked(bash("sh -c 'echo x > docs/adr/0001-x.md'"))).toContain(PROTECTED);
    expect(blocked(bash('bash -c "pnpm add better-auth"'))).toContain("better-auth");
    expect(bash('bash -c "pnpm install"')).toEqual({ allow: true });
    expect(bash("sh -c 'ls docs'")).toEqual({ allow: true });
  });

  it("blocks interpreter one-liners and dd of= that name a protected path", () => {
    for (const cmd of [
      `node -e "fs.unlinkSync('scripts/guard-rules.mjs')"`,
      `node -e "require('fs').rmSync('docs',{recursive:true})"`,
      `python3 -c "import os; os.remove('architecture.json')"`,
      `perl -e 'unlink "biome.json"'`,
      "dd of=architecture.json",
      "dd if=/dev/zero of=docs/adr/0001-x.md",
    ])
      expect(blocked(bash(cmd)), cmd).toBeDefined();
    expect(blocked(bash("dd if=/dev/zero of=packages/widgets/x"))).toContain(
      "not a package declared",
    );
  });

  it("allows one-liners that do not name a protected path", () => {
    expect(bash('node -e "console.log(1)"')).toEqual({ allow: true });
    expect(bash(`python3 -c "print('hi')"`)).toEqual({ allow: true });
    expect(bash("dd if=a of=/tmp/out")).toEqual({ allow: true });
    // Deliberate false positive: even a read-only one-liner that names a protected file is blocked;
    // telling a read from a write inside an interpreter string is not possible. Use cat or Read.
    expect(blocked(bash(`node -e "require('./architecture.json')"`))).toBeDefined();
    // Known limit: a path assembled at run time is not seen. CI arch-check is the backstop.
    expect(bash(`node -e "fs.unlinkSync('scr'+'ipts/guard-rules.mjs')"`)).toEqual({ allow: true });
  });

  it("resolves relative targets after cd", () => {
    for (const cmd of [
      "cd scripts && echo > guard-rules.mjs",
      "cd scripts; rm guard-rules.mjs",
      "cd docs && rm -rf adr",
      "cd docs/adr && touch 0002-x.md",
      "cd ../elsewhere; cd scripts && tee guard-rules.mjs",
      'bash -c "cd scripts && echo > guard-rules.mjs"',
    ])
      expect(blocked(bash(cmd)), cmd).toContain(PROTECTED);
    expect(bash("cd packages/domain && echo > src/a.ts")).toEqual({ allow: true });
    expect(bash("cd docs && echo > guide.md")).toEqual({ allow: true });
    expect(bash("cd scripts && cat arch-contract.mjs")).toEqual({ allow: true });
  });

  it("keeps harmless commands allowed", () => {
    for (const cmd of [
      "cat architecture.json",
      "ls docs",
      "ls scripts",
      "git status",
      "pnpm verify",
    ])
      expect(bash(cmd), cmd).toEqual({ allow: true });
  });

  describe("decoy scaffold block", () => {
    const MSG = "The scaffold block in CLAUDE.md is protected; edit only outside the block.";
    const decoy = "<!-- scaffold:begin decoy -->\n<!-- scaffold:end -->\n";
    it("blocks a Write that keeps the real block but adds a second begin marker", () => {
      expect(
        blocked(guard("Write", { file_path: "CLAUDE.md", content: `${decoy}${CLAUDE_MD}` })),
      ).toBe(MSG);
      expect(
        blocked(guard("Write", { file_path: "CLAUDE.md", content: `${CLAUDE_MD}\n${decoy}` })),
      ).toBe(MSG);
    });
    it("blocks an Edit or MultiEdit that introduces a begin marker", () => {
      const e = { file_path: "CLAUDE.md", old_string: "# Mine", new_string: decoy };
      expect(blocked(guard("Edit", e))).toBe(MSG);
      expect(blocked(guard("MultiEdit", { file_path: "CLAUDE.md", edits: [e] }))).toBe(MSG);
    });
    it("still allows a Write that keeps exactly the one block", () => {
      expect(guard("Write", { file_path: "CLAUDE.md", content: `new\n${CLAUDE_MD}` })).toEqual({
        allow: true,
      });
    });
  });

  describe("case-insensitive platforms", () => {
    const run = (platform: string | undefined, tool: string, input: Record<string, unknown>) =>
      decide({ tool, input, contract, root, home: "/home/u", claudeMdText: CLAUDE_MD, platform });
    it.each(["darwin", "win32"])("blocks case variants on %s", (platform) => {
      expect(
        blocked(run(platform, "Write", { file_path: "Architecture.json", content: "x" })),
      ).toContain("protected");
      expect(
        blocked(run(platform, "Write", { file_path: "DOCS/ADR/x.md", content: "x" })),
      ).toContain("protected");
      expect(
        blocked(
          run(platform, "Write", { file_path: abs("Scripts/Guard-Rules.mjs"), content: "x" }),
        ),
      ).toContain("protected");
      expect(
        blocked(run(platform, "Write", { file_path: "claude.md", content: "# Mine\n" })),
      ).toContain("scaffold block");
      expect(blocked(run(platform, "Bash", { command: "rm Architecture.json" }))).toContain(
        PROTECTED,
      );
      expect(blocked(run(platform, "Bash", { command: "echo x > claude.md" }))).toContain(
        "CLAUDE.md must not",
      );
      expect(blocked(run(platform, "Bash", { command: "rm -rf Docs" }))).toBeDefined();
      expect(
        blocked(run(platform, "Write", { file_path: "Packages/Widgets/a.ts", content: "x" })),
      ).toContain("not a package declared");
      expect(
        run(platform, "Write", { file_path: "Docs/ADR/Proposed/0004-x.md", content: "x" }),
      ).toEqual({ allow: true });
    });
    it("stays case-sensitive on linux and when no platform is given", () => {
      for (const platform of ["linux", undefined]) {
        expect(run(platform, "Write", { file_path: "Architecture.json", content: "x" })).toEqual({
          allow: true,
        });
        expect(run(platform, "Write", { file_path: "claude.md", content: "x" })).toEqual({
          allow: true,
        });
        expect(run(platform, "Bash", { command: "rm Architecture.json" })).toEqual({ allow: true });
      }
    });
  });
});
