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
