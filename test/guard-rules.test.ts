import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decide, targetsOf } from "../templates/root/scripts/guard-rules.mjs";
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

describe("guard decision: audit follow-ups (#29)", () => {
  const PROTECTED = "protected path";

  it("follows chained cd, pushd and cd options", () => {
    for (const cmd of [
      "cd apps/api && cd ../../scripts && echo > guard-rules.mjs",
      "cd -- scripts && echo > guard-rules.mjs",
      "cd -P scripts && echo > guard-rules.mjs",
      "pushd scripts && rm guard-rules.mjs",
      "cd apps; cd ../scripts; touch guard-rules.mjs",
    ])
      expect(blocked(bash(cmd)), cmd).toContain(PROTECTED);
  });

  it("blocks rm/mv behind a path, backslash, quotes or -t", () => {
    for (const cmd of [
      "/bin/rm -rf docs",
      "\\rm -rf docs",
      '"rm" -rf docs',
      "'rm' -rf scripts",
      "mv -t /tmp docs",
      "mv --target-directory=/tmp scripts",
      "sudo rm -rf docs",
      "find . -exec rm -rf docs ;",
    ])
      expect(blocked(bash(cmd)), cmd).toMatch(/protected path/);
  });

  it("does not block rm of . after a cd elsewhere", () => {
    expect(bash("cd /tmp/work && rm -rf .")).toEqual({ allow: true });
    expect(bash("cd apps/api && rm -rf ./")).toEqual({ allow: true });
    expect(blocked(bash("rm -rf ."))).toContain("protected paths");
    expect(blocked(bash("cd apps && cd .. && rm -rf ."))).toContain("protected paths");
  });

  it("resolves only operands against cd bases, never command names or flags", () => {
    expect(bash("cd apps && touch api/src/x.ts")).toEqual({ allow: true });
    expect(bash("cd apps && mkdir -p web/src/components")).toEqual({ allow: true });
    expect(blocked(bash("cd apps && mkdir -p newpkg/src"))).toContain("not a package declared");
  });

  it("does not treat quoted text as commands", () => {
    expect(bash('git commit -m "docs: rm docs mention"')).toEqual({ allow: true });
    expect(bash("echo 'rm -rf docs'")).toEqual({ allow: true });
    expect(bash("node -e \"console.log('scripts are fine')\"")).toEqual({ allow: true });
    expect(bash("node scripts/arch-check.mjs -c")).toEqual({ allow: true });
    expect(bash("python3 -m pytest -c pytest.ini")).toEqual({ allow: true });
  });

  it("blocks one-liners that mention a protected folder as a path or quoted literal", () => {
    expect(blocked(bash(`node -e "fs.rmSync('docs',{recursive:true})"`))).toBeDefined();
    expect(blocked(bash(`node -e "fs.rmSync('docs/',{recursive:true})"`))).toBeDefined();
    expect(blocked(bash(`node -pe "require('fs').readdirSync('scripts')"`))).toBeDefined();
    expect(blocked(bash(`deno eval "Deno.removeSync('architecture.json')"`))).toBeDefined();
    expect(blocked(bash(`npx tsx -e "fs.rmSync('biome.json')"`))).toBeDefined();
    expect(blocked(bash(`perl -pi -e 's/a/b/' architecture.json`))).toBeDefined();
  });

  it("fails closed when shell strings nest too deeply", () => {
    const deep = `bash -c "bash -c \\"bash -c \\\\\\"bash -c \\\\\\\\\\\\\\"npm install\\\\\\\\\\\\\\"\\\\\\"\\""`;
    expect(blocked(bash(deep))).toBeDefined();
  });

  it("follows >| and >& redirects", () => {
    expect(blocked(bash("echo x >| architecture.json"))).toContain(PROTECTED);
    expect(blocked(bash("echo x >& architecture.json"))).toContain(PROTECTED);
    expect(blocked(bash("echo x &> architecture.json"))).toContain(PROTECTED);
    expect(bash("echo x 2>&1")).toEqual({ allow: true });
    expect(bash("echo x >&2")).toEqual({ allow: true });
  });

  it("blocks whole-tree reverts from a revision", () => {
    for (const cmd of [
      "git checkout HEAD~5 -- .",
      "git checkout main .",
      "git restore --source=HEAD~5 .",
      "git restore -s HEAD~5 .",
    ])
      expect(blocked(bash(cmd)), cmd).toContain("via git");
    expect(bash("git checkout -- .")).toEqual({ allow: true });
    expect(bash("git restore .")).toEqual({ allow: true });
  });

  it("documents known limits: these are allowed, CI arch-check is the backstop", () => {
    for (const cmd of [
      "echo 'rm -rf docs' | sh",
      'bash <<< "npm install"',
      "echo docs | xargs rm -rf",
      "find docs -delete",
      "git reset --hard HEAD~5",
      "rm -rf d*",
    ])
      expect(bash(cmd), cmd).toEqual({ allow: true });
    // Windows aliases for the same file are not normalised.
    for (const name of ["architecture.json.", "architecture.json::$DATA"])
      expect(
        decide({
          tool: "Write",
          input: { file_path: name, content: "x" },
          contract,
          root,
          platform: "win32",
        }),
      ).toEqual({ allow: true });
  });
});

describe("guard decision: re-audit follow-ups (#29)", () => {
  it("decides in linear time however many cds a command chains", () => {
    for (const n of [20, 200]) {
      const cmd = `${"cd a && ".repeat(n)}touch f0 f1 f2 f3 f4 f5 f6 f7 f8 f9 architecture.json`;
      const t0 = performance.now();
      const r = bash(cmd);
      expect(performance.now() - t0, `${n} cds`).toBeLessThan(200);
      expect(r.allow, `${n} cds`).toBe(false);
    }
    const words = Array.from({ length: 900 }, (_, i) => `w${i}`).join(" ");
    const t0 = performance.now();
    expect(bash(`${"cd a; ".repeat(30)}cat ${words}`)).toEqual({ allow: true });
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it("blocks commands with too many directory changes or too long", () => {
    expect(blocked(bash(`${"cd a; ".repeat(40)}ls`))).toContain("too complex");
    expect(blocked(bash(`echo ${"x".repeat(300_000)}`))).toContain("too complex");
  });

  describe("no regression vs main (all blocked)", () => {
    it.each([
      "sudo -u root rm architecture.json",
      "nice -n 10 rm architecture.json",
      "env -u FOO rm architecture.json",
      "timeout 5 rm architecture.json",
      "stdbuf -o0 rm architecture.json",
      "ionice -c3 rm architecture.json",
      "busybox rm architecture.json",
      "parallel rm ::: architecture.json",
      "echo architecture.json | xargs rm",
      "find . -name architecture.json -exec rm {} +",
      'echo "$(rm architecture.json)"',
      'x="$(rm -rf docs)"',
      'echo "`rm architecture.json`"',
      "$'rm' architecture.json",
      '$"rm" architecture.json',
      "X=rm; $X architecture.json",
      "bash -c $'rm architecture.json'",
      "bash -c rm\\ architecture.json",
      "eval rm architecture.json",
      "eval npm install",
      'watch -n1 "rm architecture.json"',
      'flock /tmp/l -c "rm architecture.json"',
      'su -c "rm architecture.json"',
      'script -qc "rm architecture.json" /dev/null',
      "git -c alias.x='!rm architecture.json' x",
      "sudo -u root git restore architecture.json",
      `pnpm exec node -e "fs.unlinkSync('architecture.json')"`,
      `npm exec -- node -e "fs.unlinkSync('architecture.json')"`,
      `sudo -u root node -e "fs.unlinkSync('architecture.json')"`,
    ])("blocks %s", (cmd) => {
      expect(blocked(bash(cmd)), cmd).toBeDefined();
    });

    it("still allows quoted text and plain commands", () => {
      for (const cmd of [
        'echo "rm architecture.json"',
        "echo '$(rm architecture.json)'",
        'echo "$(date)"',
        "timeout 5 ls docs",
        "sudo -u root ls",
        "pnpm exec node scripts/x.mjs",
        "bash -c 'ls docs'",
        "eval ls",
      ])
        expect(bash(cmd), cmd).toEqual({ allow: true });
    });
  });

  it("keeps the root for `cd x || rm -rf .` and narrows for && and ;", () => {
    expect(blocked(bash("cd nowhere || rm -rf ."))).toContain("protected paths");
    expect(bash("cd /tmp/work && rm -rf .")).toEqual({ allow: true });
  });

  it("folds command names on case-insensitive platforms", () => {
    const run = (platform: string, command: string) =>
      decide({ tool: "Bash", input: { command }, contract, root, platform });
    expect(blocked(run("darwin", "RM -rf docs"))).toBeDefined();
    expect(blocked(run("win32", "Git Restore architecture.json"))).toBeDefined();
    expect(run("linux", "RM -rf docs")).toEqual({ allow: true });
  });

  describe("targetsOf", () => {
    const parse = (cmd: string) => targetsOf(cmd, "/proj");
    it("returns commands without wrappers, quotes or flags-as-paths", () => {
      const { commands } = parse(`sudo rm -rf "my docs" && echo 'a b'`);
      expect(commands.map((c) => c.name)).toEqual(["rm", "echo"]);
      expect(commands[0]?.args.map((a: { text: string }) => a.text)).toEqual(["-rf", "my docs"]);
    });
    it("collects redirects apart from words", () => {
      const { redirects, commands } = parse("echo x 2>&1 >| a.txt >> b.txt");
      expect(redirects.map((r) => [r.op, r.target])).toEqual([
        [">", "a.txt"],
        [">>", "b.txt"],
      ]);
      expect(commands[0]?.args.map((a: { text: string }) => a.text)).toEqual(["x"]);
    });
    it("tracks cd bases and tight directories", () => {
      const { commands } = parse("cd a && cd ../b; ls");
      expect(commands[2]?.bases).toEqual(["/proj", "/proj/a", "/proj/b", "/b"]);
      expect(commands[2]?.tight).toEqual(["/proj/b"]);
      expect(parse("cd a || ls").commands[1]?.tight).toEqual(["/proj"]);
    });
    it("returns substitutions inside double quotes as nested commands", () => {
      expect(parse("echo \"$(rm x) `ls`\" '$(no)'").nested).toEqual(["rm x", "ls"]);
    });
    it("keeps the number of bases linear", () => {
      const { commands } = parse(`${"cd a && ".repeat(30)}ls`);
      expect(commands.at(-1)?.bases.length).toBeLessThanOrEqual(61);
    });
  });
});

describe("guard decision: third audit follow-ups (#29)", () => {
  const cds = "cd a && ".repeat(32);
  const many = (n: number, w = "a") => Array.from({ length: n }, () => w).join(" ");

  describe("work budget", () => {
    const timed = (cmd: string) => {
      const t0 = performance.now();
      const r = bash(cmd);
      return { r, ms: performance.now() - t0 };
    };

    it("decides a long xargs pipeline in linear time", () => {
      const { r, ms } = timed(
        `echo a | ${Array.from({ length: 3000 }, () => "xargs rm a").join(" | ")}; rm architecture.json`,
      );
      expect(ms).toBeLessThan(500);
      expect(r.allow).toBe(false);
    });

    it.each([
      ["timeout + rm with many args", `${cds}timeout 5 rm ${many(12000)}`],
      ["rm with many args", `${cds}rm ${many(12000)}`],
      ["long node -e", `${cds}node -e "${many(12000, "x.y")}"`],
      ["git checkout with many paths", `${cds}git checkout HEAD~1 -- ${many(12000)}`],
      ["many redirects", `${cds}echo ${many(8000, ">f")}`],
    ])("blocks %s as too complex, fast", (_name, cmd) => {
      const t0 = performance.now();
      const r = bash(cmd);
      expect(performance.now() - t0).toBeLessThan(500);
      expect(blocked(r)).toContain("too complex");
    });

    it("blocks a command over 50k characters", () => {
      expect(blocked(bash(`echo ${"x".repeat(60_000)}`))).toContain("too complex");
    });

    it("keeps ordinary long commands allowed", () => {
      expect(bash(`ls ${many(500)}`)).toEqual({ allow: true });
      expect(bash(`cd packages/domain && rm ${many(200, "x.txt")}`)).toEqual({ allow: true });
    });
  });

  describe("no regression vs main: in-place edits and tee behind prefixes", () => {
    it.each([
      "timeout 5 sed -i s/a/b/ architecture.json",
      "timeout 5 sed -i.bak s/a/b/ architecture.json",
      "timeout 5 perl -pi -e s/a/b/ architecture.json",
      "timeout 5 sed -i s/a/b/ CLAUDE.md",
      "timeout 5 tee CLAUDE.md",
      "echo x | timeout 5 tee CLAUDE.md",
    ])("blocks %s", (cmd) => {
      expect(blocked(bash(cmd)), cmd).toBeDefined();
    });
    it("allows tee -a and reads behind a prefix", () => {
      expect(bash("echo x | timeout 5 tee -a CLAUDE.md")).toEqual({ allow: true });
      expect(bash("timeout 5 sed s/a/b/ architecture.json")).toEqual({ allow: true });
    });
  });

  describe("heredocs", () => {
    const BODY =
      "fix(guard): block rm of docs/adr\n\n- cp and mv into scripts/ are blocked\n- don't run `rm architecture.json`\n";
    it("does not parse a heredoc body as commands", () => {
      expect(bash(`git commit -m "$(cat <<'EOF'\n${BODY}EOF\n)"`)).toEqual({ allow: true });
      expect(bash(`gh pr create --title t --body "$(cat <<'EOF'\n${BODY}EOF\n)"`)).toEqual({
        allow: true,
      });
      expect(bash(`cat > docs/notes.md <<'EOF'\n${BODY}EOF`)).toEqual({ allow: true });
      expect(bash(`cat <<-EOF\n\t${BODY.split("\n")[0]}\n\tEOF\nls`)).toEqual({ allow: true });
    });
    it("still checks the redirect target and what follows the body", () => {
      expect(blocked(bash(`cat > architecture.json <<'EOF'\nx\nEOF`))).toContain("protected path");
      expect(blocked(bash(`cat > docs/adr/0009-x.md <<EOF\nx\nEOF`))).toContain("protected path");
      expect(blocked(bash(`cat <<'EOF'\nx\nEOF\nrm architecture.json`))).toContain(
        "protected path",
      );
      expect(blocked(bash(`cat <<EOF | tee architecture.json\nx\nEOF`))).toBeDefined();
    });
    it("runs a body fed to a shell or interpreter, and unquoted-delimiter substitutions", () => {
      expect(blocked(bash(`bash <<'EOF'\nrm architecture.json\nEOF`))).toContain("protected path");
      expect(blocked(bash(`sh <<EOF\nnpm install\nEOF`))).toContain("This project uses pnpm");
      expect(
        blocked(bash(`node <<EOF\nrequire('fs').rmSync('scripts/guard-rules.mjs')\nEOF`)),
      ).toContain("interpreter code");
      expect(
        blocked(bash(`python3 - <<'EOF'\nimport os; os.remove("architecture.json")\nEOF`)),
      ).toBeDefined();
      expect(blocked(bash(`cat <<EOF\n$(rm architecture.json)\nEOF`))).toBeDefined();
      expect(bash(`cat <<'EOF'\n$(rm architecture.json)\nEOF`)).toEqual({ allow: true });
      expect(bash(`node <<EOF\nconsole.log(1)\nEOF`)).toEqual({ allow: true });
    });
  });

  describe("read-only tools skip the write-word fallback", () => {
    it.each([
      "grep rm architecture.json",
      "grep -rn touch scripts/",
      "rg -n mkdir scripts",
      "git log --grep install -- scripts",
      "git grep tee -- scripts",
      "git show HEAD:architecture.json",
      "man rm",
      "which rm",
      "cat architecture.json",
      "head -n 3 docs/adr/0001-x.md",
    ])("allows %s", (cmd) => {
      expect(bash(cmd), cmd).toEqual({ allow: true });
    });
    it("still checks their redirects", () => {
      expect(blocked(bash("grep rm x > architecture.json"))).toContain("protected path");
      expect(blocked(bash("cat a >| scripts/x.mjs"))).toContain("protected path");
    });
  });

  it("checks folders and dd of= behind unknown prefixes", () => {
    for (const cmd of [
      "timeout 5 rm -rf docs",
      "timeout 5 mv docs /tmp",
      "timeout 5 rm -rf .",
      "timeout 5 dd of=architecture.json",
      "nice -n 5 dd if=/dev/zero of=docs/adr/0001-x.md",
    ])
      expect(blocked(bash(cmd)), cmd).toBeDefined();
    expect(bash("timeout 5 mv foo.txt docs")).toEqual({ allow: true });
    expect(bash("timeout 5 dd if=a of=/tmp/out")).toEqual({ allow: true });
  });

  it("documents more known limits: allowed, CI arch-check is the backstop", () => {
    for (const cmd of [
      "rsync -a --delete empty/ docs/",
      "chmod 000 architecture.json",
      `rm${"$"}{IFS}-rf${"$"}{IFS}docs`,
      "echo 'rm -rf docs' | bash",
      'bash <<< "npm install"',
      'bash -c -- "rm architecture.json"',
      "git checkout HEAD -- 'docs/ad*'",
      "git reset --hard HEAD~3",
      "echo docs | xargs rm -rf",
      "find docs -delete",
    ])
      expect(bash(cmd), cmd).toEqual({ allow: true });
  });
});

describe("guard decision: fourth audit follow-ups (#29)", () => {
  describe("heredoc scanning: safe by default", () => {
    it.each([
      "cat <<$'EOF'\nx\nEOF\nrm architecture.json",
      'cat <<$"EOF"\nx\nEOF\nrm architecture.json',
      "echo $((1<<2))\nrm architecture.json\n2",
      "(( x = 1<<3 ))\nrm architecture.json\n3",
      "echo $[1<<2]\nrm architecture.json\n2",
      "if (( x = 1<<3 )); then\nrm architecture.json\n3\nfi",
      "echo hi # <<EOF\nrm architecture.json\nEOF",
      'echo "$((1<<2))"\nrm architecture.json\n2',
      "cat <<'EOF' | sh\nrm architecture.json\nEOF",
      "cat <<'EOF' | bash\nrm architecture.json\nEOF",
      "bash <<X\ncat <<'Y' | sh\nrm architecture.json\nY\nX",
      "sudo -u x bash <<EOF\nrm architecture.json\nEOF",
      "timeout 5 bash <<EOF\nrm architecture.json\nEOF",
      "source /dev/stdin <<EOF\nrm architecture.json\nEOF",
      ". /dev/stdin <<EOF\nrm architecture.json\nEOF",
      "xargs rm <<'EOF'\narchitecture.json\nEOF",
      "cat <<'EOF' | xargs rm\narchitecture.json\nEOF",
      "cat <<EOF | node\nrequire('fs').rmSync('scripts/guard-rules.mjs')\nEOF",
      "echo $(( $(rm architecture.json) ))",
      "((rm architecture.json))",
    ])("blocks %s", (cmd) => {
      expect(blocked(bash(cmd)), JSON.stringify(cmd)).toBeDefined();
    });

    it("treats a comment as a comment", () => {
      expect(bash("echo hi # rm architecture.json")).toEqual({ allow: true });
      expect(bash("echo hi # <<EOF")).toEqual({ allow: true });
      expect(bash(`echo \${#PATH} $#`)).toEqual({ allow: true });
    });

    it("still skips bodies for known data sinks", () => {
      const body = "block rm of docs/adr, cp into scripts/\n";
      for (const cmd of [
        `cat <<'EOF'\n${body}EOF`,
        `cat > notes.md <<'EOF'\n${body}EOF`,
        `cat <<'EOF' | grep rm\n${body}EOF`,
        `cat <<'EOF' | tee notes.md\n${body}EOF`,
        `git commit -F - <<'EOF'\n${body}EOF`,
        `gh pr create --body-file - <<'EOF'\n${body}EOF`,
        `git commit -m "$(cat <<'EOF'\n${body}EOF\n)"`,
        `echo $((1<<2))\nls\n`,
      ])
        expect(bash(cmd), cmd).toEqual({ allow: true });
    });
  });

  describe("read-only exemption: safe by default", () => {
    it.each([
      "rg --pre rm x architecture.json",
      "rg --pre=rm x scripts",
      "man -P 'rm architecture.json' ls",
      "MANPAGER='rm architecture.json' man ls",
      "LESSOPEN='|rm %s' less architecture.json",
      "PAGER='rm architecture.json' git log",
      "GIT_PAGER='rm architecture.json' git log",
      "git -c core.pager='rm architecture.json' log",
      "git -c diff.external='rm architecture.json' diff",
      "git -c core.fsmonitor='rm architecture.json' status",
      "git -c core.sshCommand='rm architecture.json' fetch",
      "git -c core.editor='rm architecture.json' commit",
      "git -c credential.helper='!rm architecture.json' fetch",
      "git diff --output=architecture.json",
      "git log --output architecture.json",
      "sort -o architecture.json x",
      "sort -oarchitecture.json x",
      "less -o architecture.json x",
    ])("blocks %s", (cmd) => {
      expect(blocked(bash(cmd)), cmd).toBeDefined();
    });

    it("keeps plain readers allowed", () => {
      for (const cmd of [
        "git log -p -- scripts",
        "git diff HEAD architecture.json",
        "rg -n pre scripts",
        "man ls",
        "less architecture.json",
        "sort x -o /tmp/out",
        "git -C . log",
      ])
        expect(bash(cmd), cmd).toEqual({ allow: true });
    });
  });

  it("explains that read-only interpreter code is blocked on purpose", () => {
    expect(
      blocked(bash(`python3 - <<'EOF'\nimport json; json.load(open('architecture.json'))\nEOF`)),
    ).toContain("read it with cat");
  });

  it("keeps the unterminated-heredoc and deep nesting cases bounded", () => {
    const t0 = performance.now();
    const r = bash(`${'echo "$('.repeat(400)}x`);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(blocked(r)).toContain("too complex");
    expect(bash("cat <<EOF\nno end")).toEqual({ allow: true });
  });
});

describe("guard decision: fifth audit follow-ups (#29)", () => {
  it.each([
    "echo $'it\\'s' ; rm architecture.json",
    "echo $'\\'' ; rm architecture.json ; echo $'\\''",
    "$'\\x72m' architecture.json",
    "$'\\162m' architecture.json",
    "$'\\u0072m' architecture.json",
    "$'r\\x6d' architecture.json",
    "timeout 5 $'\\x72m' architecture.json",
    "cat > /tmp/x.sh <<'EOF'\nrm architecture.json\nEOF\nbash /tmp/x.sh",
    "cat > /tmp/x.sh <<'EOF'\nrm architecture.json\nEOF\nsh /tmp/x.sh",
    "tee /tmp/x.sh <<'EOF'\nrm architecture.json\nEOF\n. /tmp/x.sh",
    "cat <<'EOF' > /tmp/x.sh && bash /tmp/x.sh\nrm architecture.json\nEOF",
    "cat > /tmp/x.sh <<'EOF'\nrm architecture.json\nEOF\nchmod +x /tmp/x.sh; /tmp/x.sh",
    "cat > /tmp/x.js <<'EOF'\nrequire('fs').rmSync('architecture.json')\nEOF\nnode /tmp/x.js",
    "git -c gpg.program='rm architecture.json' log --show-signature",
    "git -c diff.x.command='rm architecture.json' diff",
    "git -c filter.x.clean='rm architecture.json' add .",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0='rm architecture.json' git log",
    "X='rm architecture.json'; eval $X",
    "X='rm architecture.json'; $X",
    "X='rm architecture.json' bash -c '$X'",
  ])("blocks %s", (cmd) => {
    expect(blocked(bash(cmd)), JSON.stringify(cmd)).toBeDefined();
  });

  it("allows the harmless counterparts", () => {
    for (const cmd of [
      "echo $'it\\'s' ; echo done",
      "echo $'a\\tb' > /tmp/out",
      "cat > /tmp/run.sh <<'EOF'\npnpm test\nEOF\nbash /tmp/run.sh",
      "cat > /tmp/notes.txt <<'EOF'\nrm architecture.json\nEOF\ncat /tmp/notes.txt",
      "cat > /tmp/x.sh <<'EOF'\nrm architecture.json\nEOF\nls /tmp/x.sh",
      'git -c user.name="A B" commit -m x',
      "git -c core.pager=cat log",
      'MSG="update the docs" git commit -m "$MSG"',
      "NODE_ENV=test pnpm test",
      "X='ls docs'; $X",
    ])
      expect(bash(cmd), cmd).toEqual({ allow: true });
  });
});
