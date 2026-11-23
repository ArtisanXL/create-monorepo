import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decide } from "../templates/root/scripts/guard-rules.mjs";
import { targetsOf } from "../templates/root/scripts/shell-lex.mjs";
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
    // (`bash <<< "npm install"` and `rm -rf d*` were closed by #37.)
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
      // `;` runs the next command even when a `cd` failed, so it does not narrow
      expect(commands[2]?.tight).toEqual(["/proj"]);
      expect(parse("cd a && cd ../b && ls").commands[2]?.tight).toEqual(["/proj/b"]);
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

  // `bash <<< "npm install"` was closed by #37; the remaining limits are listed in "remaining limits" below.
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

describe("guard decision: text built at run time (#29)", () => {
  it.each([
    "echo 'rm architecture.json' | sh",
    "printf 'rm architecture.json\\n' | bash",
    "bash <<< 'rm architecture.json'",
    'sh <<< "rm architecture.json"',
    "bash -c -- 'rm architecture.json'",
    "bash < <(echo 'rm architecture.json')",
    "source <(echo 'rm architecture.json')",
    ". <(echo 'rm architecture.json')",
    "eval \"$(echo 'rm architecture.json')\"",
    "$(echo rm) architecture.json",
    "`echo rm` architecture.json",
    'echo "rm architecture.json" > /tmp/x.sh; bash /tmp/x.sh',
    "cat > /tmp/x.sh <<'EOF'\nrm architecture.json\nEOF\nbash < /tmp/x.sh",
    "cat > /tmp/x.sh <<'EOF'\nrm architecture.json\nEOF\ncat /tmp/x.sh | bash",
    "cat > /tmp/x.sh <<'EOF'\nrm architecture.json\nEOF\nxargs -a /tmp/x.sh rm",
    "cat > /tmp/x.sh <<'EOF'\nrm architecture.json\nEOF\ncd /tmp && bash x.sh",
    "cat > /tmp/x.sh <<'EOF'\nrm architecture.json\nEOF\nbash ~/../../tmp/x.sh",
    "read -r X <<< 'rm architecture.json'; $X",
  ])("blocks %s", (cmd) => {
    expect(blocked(bash(cmd)), JSON.stringify(cmd)).toBeDefined();
  });

  it("keeps ordinary uses of these constructs allowed", () => {
    for (const cmd of [
      "echo 'pnpm test' | bash",
      "cat > /tmp/run.sh <<'EOF'\npnpm test\nEOF\nbash /tmp/run.sh",
      'FILES="a b"; rm $FILES',
      "cat <<EOF | node\nconsole.log(1)\nEOF",
      "psql <<EOF\nselect 1;\nEOF",
      "bash scripts/verify.sh",
      "node scripts/arch-check.mjs",
      'bash -c "ls docs"',
      "eval ls",
      'echo hi | node -e "console.log(1)"',
    ])
      expect(bash(cmd), cmd).toEqual({ allow: true });
  });

  it("suggests git commit -F - when a message variable trips the guard", () => {
    expect(blocked(bash('MSG="rm docs/adr/0001-x.md" git commit -m "$MSG"'))).toContain(
      "git commit -F -",
    );
  });
});

describe("guard decision: seventh audit follow-ups (#29)", () => {
  it.each([
    "echo 'echo x > architecture.json' | sh",
    "echo 'echo x >> architecture.json' | sh",
    "echo 'echo x >| architecture.json' | bash",
    "sh -c \"$(printf 'rm architecture.json')\"",
    "bash -c \"`printf 'rm architecture.json'`\"",
    "bash -c $(printf 'rm architecture.json')",
    "bash -c `printf 'rm architecture.json'`",
    "X='rm architecture.json'; bash -c \"$X\"",
    '"$(echo rm)" architecture.json',
    'X=rm; "$X" architecture.json',
    '"`echo rm`" architecture.json',
  ])("blocks %s", (cmd) => {
    expect(blocked(bash(cmd)), cmd).toBeDefined();
  });

  it("does not treat the project's own protected scripts as run-time text", () => {
    for (const cmd of [
      "node scripts/worktree.mjs setup && pnpm install",
      "node scripts/arch-check.mjs | tee /tmp/a.log",
      "rm -rf node_modules && node scripts/worktree.mjs setup",
      "mkdir -p /tmp/x && node scripts/arch-check.mjs",
      "bash scripts/check.sh && rm -rf dist",
      "pnpm exec tsx scripts/seed.ts && rm -rf tmp",
      "node scripts/arch-check.mjs && touch /tmp/ok",
      'node scripts/arch-check.mjs; git commit -m "fix: rm stale docs/adr link"',
      "node scripts/arch-check.mjs < input.txt",
    ])
      expect(bash(cmd), cmd).toEqual({ allow: true });
  });

  it("still triggers on scripts outside protected paths and on stdin", () => {
    expect(blocked(bash("node tools/x.mjs && rm architecture.json"))).toBeDefined();
    expect(blocked(bash("bash /tmp/x.sh; cp architecture.json /tmp/a"))).toBeDefined();
    expect(
      blocked(
        bash(
          "echo 'rm architecture.json' | node scripts/arch-check.mjs && echo 'rm architecture.json' | sh",
        ),
      ),
    ).toBeDefined();
  });

  it("decides in linear time on long runs of newlines, spaces and separators", () => {
    for (const unit of ["\n", " ", ";", "\n ", "$", "(", "`", '"$('])
      for (const n of [50_000 / unit.length]) {
        const t0 = performance.now();
        bash(unit.repeat(n));
        expect(performance.now() - t0, JSON.stringify(unit)).toBeLessThan(500);
      }
  });

  // Everything documented here was closed by #34 and #37; the remaining limits are listed below.
});

describe("guard decision: remaining limits (#34)", () => {
  describe("code piped or redirected into interpreters", () => {
    it.each([
      `echo "fs.unlinkSync('architecture.json')" | node`,
      `echo "fs.writeFileSync('architecture.json', 'x')" | node`,
      `echo "os.remove('architecture.json')" | python3`,
      `echo "shutil.rmtree('docs/adr')" | python3`,
      `echo "Path('architecture.json').write_text('x')" | python3`,
      `echo "unlink 'architecture.json'" | perl`,
      `echo "open(F, '>architecture.json')" | perl`,
      `node <<< "fs.renameSync('architecture.json', 'x')"`,
      `echo "fs.openSync('architecture.json', 'w')" | node`,
    ])("blocks %s", (cmd) => {
      expect(blocked(bash(cmd)), cmd).toContain("runs text built at run time");
    });

    it.each([
      "echo 'console.log(1)' | node",
      "echo \"print('hi')\" | python3",
      "echo \"fs.unlinkSync('/tmp/x')\" | node",
      "echo \"fs.readFileSync('package.json')\" | node",
      "python3 -c \"$(echo 'print(1)')\"",
    ])("allows %s", (cmd) => {
      expect(bash(cmd), cmd).toEqual({ allow: true });
    });
  });

  describe("decoders piped into executors", () => {
    it.each([
      "echo cm0gYXJjaGl0ZWN0dXJlLmpzb24= | base64 -d | sh",
      "echo cm0= | base64 --decode | bash",
      "echo 726d | xxd -r -p | sh",
      "openssl enc -d -aes-256-cbc -in x.enc | sh",
      "zcat x.gz | sh",
      "gunzip -c x.gz | bash",
      "base64 -d x.b64 | node",
      "bash <(base64 -d x.b64)",
      'eval "$(base64 -d x.b64)"',
    ])("blocks %s", (cmd) => {
      expect(blocked(bash(cmd)), cmd).toContain("decoded or decompressed");
    });

    it.each([
      "base64 -d x.b64 > /tmp/out",
      "zcat x.gz | grep error",
      "gunzip -c x.gz | wc -l",
      "echo hi | base64",
      "base64 -d x.b64 | node scripts/arch-check.mjs",
      "tar xzf x.tgz && bash run.sh",
    ])("allows %s", (cmd) => {
      expect(bash(cmd), cmd).toEqual({ allow: true });
    });
  });

  describe("obfuscated and folder-only text piped into a shell", () => {
    it.each([
      "echo 'dd of=architecture.json' | sh",
      "echo \"'r''m architecture.json'\" | sh",
      "echo 'rm -rf docs' | sh",
      "echo 'rm -rf docs' | bash",
      "echo 'rm -r .github' | sh",
      "echo 'rsync -a --delete empty/ docs/' | sh",
      "echo 'find docs -delete' | sh",
      "echo 'mv docs /tmp/x' | sh",
    ])("blocks %s", (cmd) => {
      expect(blocked(bash(cmd)), cmd).toBeDefined();
    });

    it.each([
      "echo 'rm -rf dist' | sh",
      "echo 'rm -rf node_modules' | sh",
      "echo 'mkdir -p dist' | sh",
      "echo 'dd if=/dev/zero of=/tmp/x' | sh",
    ])("allows %s", (cmd) => {
      expect(bash(cmd), cmd).toEqual({ allow: true });
    });
  });

  describe("folder-only deletes", () => {
    it.each([
      "echo docs | xargs rm -rf",
      "echo .claude | xargs rm -r",
      "find docs -delete",
      "find docs -name '*.md' -delete",
      "find docs -exec rm {} ;",
      "find docs -type f -exec rm -f {} +",
      "find scripts -delete",
      "cd docs && find adr -delete",
      "rsync -a --delete empty/ docs/",
      "rsync -a --delete empty/ docs/adr/",
      "rsync -a src/ docs/adr/",
      // Searching from the project root covers every protected path (#37), whatever the name test says.
      "find . -name '*.log' -delete",
    ])("blocks %s", (cmd) => {
      expect(blocked(bash(cmd)), cmd).toBeDefined();
    });

    it.each([
      "cd src && find . -name '*.log' -delete",
      "find dist -delete",
      "find packages -name '*.tmp' -exec rm {} ;",
      "find docs -name '*.md'",
      "find docs -exec grep -l x {} ;",
      "rsync -a --delete dist/ /tmp/x/",
      "rsync -a docs/ /tmp/backup/",
      "rsync -a src/ docs/",
      "echo dist | xargs rm -rf",
      "echo docs | xargs ls",
    ])("allows %s", (cmd) => {
      expect(bash(cmd), cmd).toEqual({ allow: true });
    });
  });

  describe("variables", () => {
    it.each([
      "X=architecture.json; rm $X",
      "X=rm; Y=architecture.json; $X $Y",
      `X=architecture.json && rm ${"$"}{X}`,
      "export X=architecture.json; rm $X",
      "X=docs; rm -rf $X",
      "D=docs; F=adr/0001-package-boundaries.md; rm $D/$F",
      "A=architecture; B=$A.json; rm $B",
      "X='rm architecture.json'; $X",
      "X=architecture.json; echo hi > $X",
      "X=docs; cd $X && cd adr && rm 0001-package-boundaries.md",
      "X=architecture.json; bash -c 'rm $X'",
      'X=architecture.json; echo "$(rm $X)"',
      `rm${"$"}{IFS}architecture.json`,
      "rm$IFS$9architecture.json",
      `rm${"$"}{IFS}-rf${"$"}{IFS}docs`,
      `cat${"$"}{IFS}x;rm${"$"}{IFS}architecture.json`,
    ])("blocks %s", (cmd) => {
      expect(blocked(bash(cmd)), cmd).toBeDefined();
    });

    it.each([
      "X=foo; echo $X",
      "X=foo; rm $X",
      "X=dist; rm -rf $X",
      "X=a; X=b; rm $X",
      `echo ${"$"}{IFS}`,
      "FOO=1 node scripts/arch-check.mjs",
    ])("allows %s", (cmd) => {
      expect(bash(cmd), cmd).toEqual({ allow: true });
    });

    it("keeps growing values bounded", () => {
      const t0 = performance.now();
      bash(`X=a;${"X=$X$X;".repeat(1000)}rm $X`);
      expect(performance.now() - t0).toBeLessThan(500);
    });
  });

  describe("git", () => {
    it.each([
      "git -c include.path=/tmp/evil log",
      "git -c includeIf.gitdir:/x.path=/tmp/evil status",
      "git -c Include.Path=x status",
      "git --config-env=include.path=P log",
      "git --config-env=core.pager=PAGER_CMD log",
      "git --config-env core.pager=PAGER_CMD log",
      "git --config-env=core.editor=ED commit",
      "PAGER_CMD='rm architecture.json' git --config-env=core.pager=PAGER_CMD log",
      "P='rm architecture.json'; git --config-env=core.pager=P log",
      "git checkout HEAD~5 -- '*'",
      "git checkout HEAD~5 -- '*.json'",
      "git checkout main -- 'arch*'",
      "git checkout main -- 'docs/*'",
      "git checkout main -- 'docs/adr/0*.md'",
      "git checkout main '*.md'",
      "git restore -s HEAD~5 '*.json'",
      "git restore --source=main '*'",
      "git restore --source=main 'scripts/*.mjs'",
      "git reset --hard origin/main",
      "git reset --hard v1.0.0",
      "git reset --hard feature/x~2",
      "git reset --hard abc1234",
      "git reset -q --hard main",
      // #41: upstream and reflog revisions can point anywhere
      "git reset --hard @{u}",
      "git reset --hard @{upstream}",
      "git reset --hard HEAD@{1}",
    ])("blocks %s", (cmd) => {
      expect(blocked(bash(cmd)), cmd).toBeDefined();
    });

    it.each([
      "git reset --hard",
      "git reset --hard HEAD",
      "git reset --hard @",
      "git reset --hard HEAD~1",
      "git reset --hard HEAD~5",
      "git reset --hard HEAD^",
      "git reset --hard HEAD^^",
      "git reset --hard @~2",
      "git reset --hard ORIG_HEAD",
      "git reset --soft HEAD~1",
      "git reset HEAD~1",
      "git reset HEAD file.ts",
      "git --config-env=user.name=GIT_NAME commit -m x",
      "GIT_PAGER='less' git --config-env=core.pager=GIT_PAGER log",
      "git -c user.name=x commit -m y",
      "git -c core.pager=less log",
      "git checkout HEAD~5 -- 'src/*.ts'",
      "git checkout HEAD~5 -- apps/api/src/app.ts",
      "git checkout -- '*.ts'",
      "git restore '*.ts'",
      "git restore -s HEAD~1 'packages/domain/*.ts'",
      "git checkout main",
      "git checkout -b feature/x",
    ])("allows %s", (cmd) => {
      expect(bash(cmd), cmd).toEqual({ allow: true });
    });
  });

  describe("chmod, chown and chgrp", () => {
    it.each([
      "chmod 000 architecture.json",
      "chmod +x scripts/new.sh",
      "chmod -R a-w docs",
      "chown root architecture.json",
      "chgrp wheel docs/adr/0001-package-boundaries.md",
      "sudo chmod 777 .github/workflows/ci.yml",
      "echo 'chmod 000 architecture.json' | sh",
      "unlink architecture.json",
      "shred -u architecture.json",
      "rmdir docs/adr",
    ])("blocks %s", (cmd) => {
      expect(blocked(bash(cmd)), cmd).toBeDefined();
    });

    it.each([
      "chmod +x run.sh",
      "chmod 644 apps/api/src/app.ts",
      "chmod -R u+w dist",
      "chown me /tmp/x",
    ])("allows %s", (cmd) => {
      expect(bash(cmd), cmd).toEqual({ allow: true });
    });
  });

  describe("variables of unknown value (audit of #36)", () => {
    it.each([
      `X="$(printf '\\x72\\x6d')"; $X architecture.json`,
      "X=`printf '\\x72\\x6d'`; $X architecture.json",
      `X="$(cat f)"; $X architecture.json`,
      `X="$(printf r)"m; $X architecture.json`,
      "X=r; X+=m; $X architecture.json",
      "X=echo; read X < f; $X architecture.json",
      "X=echo; getopts r X; $X architecture.json",
      "X=echo; for X in a b; do $X architecture.json; done",
      "X=echo; printf -v X rm; $X architecture.json",
      "X=echo; mapfile X < f; $X architecture.json",
      "X=echo; unset X; $X architecture.json",
      `export X="$(cat f)"; $X architecture.json`,
      "X=$(cat f); $X architecture.json",
    ])("blocks %s", (cmd) => {
      expect(blocked(bash(cmd)), cmd).toBeDefined();
    });

    it.each([
      'TMP="$(mktemp -d)"; cp x "$TMP"; rm -rf "$TMP"',
      "TMP=`mktemp -d`; rm -rf $TMP",
      'd="$(mktemp -d)" && cd "$d" && rm -rf "$d"',
      "TMP=$(mktemp -d); rm -rf $TMP",
    ])("allows %s", (cmd) => {
      expect(bash(cmd), cmd).toEqual({ allow: true });
    });
  });

  describe("expansion budget (audit of #36)", () => {
    const X = "a ".repeat(512).trim();
    it.each([
      ["many references in one word", `X='${X}'; echo ${"$X".repeat(20_000)}`],
      ["many references as words", `X='${X}'; echo ${"$X ".repeat(15_000)}`],
      ["inside bash -c", `X='${X}'; bash -c "echo ${"$X".repeat(15_000)}"`],
      ["chained doubling", `A='${X}'; B=$A$A; C=$B$B; D=$C$C; echo ${"$D".repeat(10_000)}`],
    ])("is bounded: %s", (_n, cmd) => {
      const t0 = performance.now();
      const r = bash(cmd);
      expect(performance.now() - t0).toBeLessThan(500);
      expect(blocked(r)).toContain("too complex");
    });

    it("still expands ordinary uses", () => {
      expect(blocked(bash("X=architecture.json; rm $X $X $X"))).toBeDefined();
    });
  });

  describe("review follow-ups (audit of #36)", () => {
    it("blocks an oversized glob after a revision instead of crashing", () => {
      const r = bash(`git checkout HEAD~5 -- '${"a*".repeat(6000)}'`);
      expect(blocked(r)).toBeDefined();
    });

    it("keeps plain interpreter scripts with copy in a name allowed", () => {
      expect(bash("tsx tools/copy-assets.ts && cat vitest.config.ts")).toEqual({ allow: true });
      expect(bash("echo 'copy-assets' | node")).toEqual({ allow: true });
    });

    it.each(["gzip -dc x.gz | sh", "gzip -cd x.gz | bash", "zcat x.gz | node"])(
      "blocks %s",
      (cmd) => {
        expect(blocked(bash(cmd)), cmd).toBeDefined();
      },
    );
  });

  it("documents remaining limits: allowed, CI arch-check is the backstop", () => {
    for (const cmd of [
      // The list lives in a file the guard never reads; so does the code behind `$(cat x.js)`. Same as `node x.js`.
      "xargs rm < list",
      'node -e "$(cat x.js)"',
      'read -r X <<< "$(cat list)"; rm $X',
      "for X in $(ls); do rm -rf $X; done",
      // Interpreter and executable scripts are not given the shell-script treatment: tooling often passes them contract files.
      "node x.js architecture.json",
      "python3 -m json.tool architecture.json",
      "./x.sh architecture.json",
      // A branch or tag cannot be told from a path or a revision without asking git.
      "git checkout v1.0",
      "git switch some-branch",
      "git reset abc1234",
      "git reset --soft abc1234",
      // The git rewind check sees one command line: a reset in one call and the checkout in the next are not connected.
      "git reset abc1234",
      // A stash of a rewound index only counts when the reset is on the same line.
      "git stash -u && git stash drop",
    ])
      expect(bash(cmd), cmd).toEqual({ allow: true });
  });
});

describe("guard decision: constructed bypasses (#37)", () => {
  const cases = (blockedCmds: string[], allowedCmds: string[]) => {
    it.each(blockedCmds)("blocks %s", (cmd) => {
      expect(blocked(bash(cmd)), cmd).toBeDefined();
    });
    it.each(allowedCmds)("allows %s", (cmd) => {
      expect(bash(cmd), cmd).toEqual({ allow: true });
    });
  };

  describe("find from the project root", () => {
    cases(
      ["find . -name x -exec rm {} \\;", "find . -name x -delete", "find -delete"],
      [
        "find src -name '*.ts'",
        "find . -name '*.ts' -exec grep foo {} \\;",
        "cd src && find . -name x -delete",
        "find packages -name x -exec rm {} \\;",
      ],
    );
  });

  describe("$IFS before a quote", () => {
    cases(
      [
        "rm$IFS'architecture.json'",
        'rm$IFS"architecture.json"',
        "rm$IFS$IFS'architecture.json'",
        "rm$IFS\\architecture.json",
      ],
      ["rm$IFS'src/x.txt'", "echo$IFS'hi'"],
    );
  });

  describe("loop and read variables", () => {
    cases(
      [
        "while read X; do $X architecture.json; done <<< rm",
        "X=src; for X in docs; do rm -rf $X; done",
        "for X in src docs; do rm -rf $X; done",
        "read X <<< architecture.json; rm $X",
        "X=src/x.ts; X+=/../../architecture.json; rm $X",
        "X=docs/x; X+=/..; rm -rf $X",
        '[ -n "$Z" ] && X=architecture.json || X=foo; rm $X',
        'if [ -n "$Z" ]; then X=docs; else X=foo; fi; rm -rf $X',
      ],
      [
        "for X in dist build; do rm -rf $X; done",
        "X=src/x.ts; X+=/..; rm -rf $X",
        "X=a; X=b; rm $X",
        '[ -n "$Z" ] && X=a || X=b; rm $X',
      ],
    );
  });

  describe("interpreter text that names a folder", () => {
    cases(
      [
        "echo \"require('fs').rmSync('docs',{recursive:true})\" | node",
        "echo \"shutil.rmtree('docs')\" | python3",
        "echo \"require('fs').rmSync('docs/adr',{recursive:true})\" | node",
      ],
      [
        'node -e "console.log(1)"',
        "echo \"console.log('docs')\" | node",
        "echo \"fs.writeFileSync('out.txt','see docs')\" | node",
        "echo \"fs.rmSync('src',{recursive:true})\" | node",
      ],
    );
  });

  describe("git commands that rewrite the tree", () => {
    cases(
      [
        "git reset --keep abc1234",
        "git reset --merge origin/main",
        "git checkout abc1234",
        "git checkout HEAD~3",
        "git checkout -b feat abc1234",
        "git checkout --detach main",
        "git switch --detach abc1234",
        "git switch -c feat abc1234",
        "git read-tree -u --reset abc1234",
        "git read-tree -um abc1234",
        "git reset abc1234 && git checkout -- .",
        "git reset abc1234 && git restore .",
        "git reset abc1234; git checkout-index -a -f",
      ],
      [
        "git reset --keep HEAD~1",
        "git reset --merge",
        "git checkout -b feat",
        "git checkout main",
        "git checkout main -- src/x.ts",
        "git checkout abc1234 -- src/x.ts",
        "git checkout abc1234 src/x.ts",
        "git switch main",
        "git switch -c feat",
        "git switch --detach HEAD",
        "git read-tree -m HEAD",
        "git reset HEAD~1 && git checkout -- .",
        "git checkout -- .",
      ],
    );
  });

  describe("shell scripts handed a protected path", () => {
    cases(
      ["bash x.sh architecture.json", "sh ./x.sh biome.json", "bash -x x.sh docs/adr/0001-x.md"],
      [
        "bash scripts/x.sh",
        "bash x.sh",
        "bash x.sh -f foo",
        "bash x.sh src/a.ts",
        "bash scripts/check.sh architecture.json",
      ],
    );
  });

  describe("text formatted at run time, brace expansion, here-string scripts, globs", () => {
    cases(
      [
        "printf 'r%s architecture.json' m | sh",
        "echo -e 'rm architecture.json' | sh",
        "printf '%s\\n' hello | sh",
        "{r,}m architecture.json",
        "rm {x,architecture.json}",
        'bash <<< "npm install"',
        "rm -rf d*",
        "rm -rf docs/*",
        "rm *.json",
        "cd docs && rm -rf *",
        "mv d* /tmp",
        "chmod -R 755 d*",
      ],
      [
        "printf '%s\\n' architecture.json | cat",
        "echo -e 'a\\tb'",
        "echo {a,b}.txt",
        "rm -f {a,b}.tmp",
        "cp x{,.bak}",
        'git commit -m "x {a,b}"',
        'bash <<< "pnpm install"',
        'bash <<< "echo hi"',
        "rm -rf dist*",
        "rm -rf node_modules/*",
        "rm *.log",
        "rm -rf src/*",
        "rm -rf docs/adr/proposed/*",
        "cd src && rm -rf *",
        "mv src/* /tmp",
      ],
    );
  });

  describe("review follow-ups (#37)", () => {
    cases(
      [
        // while/until read fed by a here-string on `done`
        "while read X; do rm $X; done <<< architecture.json",
        "while read X; do rm -rf $X; done <<< docs",
        'while read X; do rm -rf "$X"; done <<< docs',
        "until read X; do rm -rf $X; done <<< docs",
        "while read X; do $X -rf docs; done <<< rm",
        'while read X; do $X; done <<< "rm architecture.json"',
        // brace ranges and character classes
        "rm {a..z}rchitecture.json",
        "rm architectur{e..e}.json",
        "rm -rf [[:alpha:]]ocs",
        "rm [[:alpha:]]rchitecture.json",
        "rm {r,}'m' architecture.json",
        // printf formats and escapes
        "printf 'rm %s.json' architecture | sh",
        "printf 'rm architecture.%s' json | sh",
        "printf 'rm architecture.js%s' on | sh",
        "echo -e 'rm\\tarchitecture.json' | bash",
        // shell scripts: -e is errexit, folders, source
        "bash -e x.sh architecture.json",
        "sh -e x.sh architecture.json",
        "bash x.sh docs",
        "bash x.sh docs/",
        "source x.sh architecture.json",
        ". x.sh architecture.json",
        // git rewinds
        "git reset abc1234 && git checkout -f",
        "git reset abc1234 && git checkout -f HEAD",
        "git reset abc1234 && git checkout -- '*'",
        "git reset abc1234 && git checkout -- :/",
        "git reset abc1234 && git checkout -- ':(top)'",
        "git reset abc1234 && git restore '*'",
        "git read-tree abc1234 && git checkout-index -a -f",
        "git reset abc1234 && git stash -u && git stash drop",
        "git checkout HEAD^",
        "git checkout feature~2",
        "git checkout HEAD@{1}",
        "git checkout FETCH_HEAD",
        "git checkout refs/heads/main",
        "git switch -C feat abc1234",
        "git switch --create feat HEAD~4",
        // find and delete globs
        "find d* -delete",
        "find * -delete",
        "shred arch*.json",
        "unlink arch*.json",
        "rm -rf */dist",
      ],
      [
        "echo {1..100}",
        "mkdir -p src/{a,b}",
        "rm -f file{1..3}.txt",
        "bash -e scripts/x.sh architecture.json",
        "bash x.sh src",
        "source x.sh src/a.ts",
        "git reset -- src/x.ts && git checkout -- .",
        "git reset HEAD -- src && git checkout .",
        "git stash -u",
        "git checkout HEAD@{0}",
        "git checkout main",
        "git switch feature",
        "git checkout -b feat origin/main",
        "git switch --create feat origin/main",
        "find src* -delete",
        "rm -rf 'dist*'",
        "rm -rf '*'",
        "find '*' -delete",
        "shred src/*.tmp",
      ],
    );

    it("says why in a message of its own", () => {
      expect(blocked(bash("find . -name x -delete"))).toContain("start the search in a subfolder");
      expect(blocked(bash("rm -rf */dist"))).toContain("A glob in this delete or move");
      expect(blocked(bash("printf 'x%s' y | sh"))).toContain("Text formatted at run time");
    });

    it("keeps long loop lists and accumulated values whole, or blocks them", () => {
      const long = Array.from({ length: 60 }, (_, k) => `src/some/long/dir/${k}`).join(" ");
      expect(bash(`for X in ${long} docs; do rm -rf $X; done`).allow).toBe(false);
      const chain = Array.from({ length: 60 }, (_, k) => `true && X=src/some/long/dir/${k}`).join(
        "; ",
      );
      expect(bash(`${chain}; true && X=docs; rm -rf $X`).allow).toBe(false);
      expect(bash(`for X in ${long}; do echo $X; done`).allow).toBe(true);
    });

    it("lexes a hostile brace word in linear time", () => {
      const cmd = `echo ${"{a,b}".repeat(5)}{${",".repeat(50_000)}`;
      for (const c of [cmd, `echo {${".".repeat(49_000)}`, `echo ${"{".repeat(20_000)}`]) {
        const t0 = performance.now();
        bash(c);
        expect(performance.now() - t0).toBeLessThan(1000);
      }
    });
  });

  describe("second review (#37)", () => {
    const pad = "x".repeat(1100);
    cases(
      [
        // globs with a quoted part still glob
        'rm -rf "d"*',
        'rm -rf d"o"c*',
        "rm -rf ''d*",
        'rm -rf "do"?s',
        'rm -rf "docs"/*',
        'rm "architecture".*',
        'rm -rf "."git*',
        'mv "d"* /tmp',
        'find "d"* -delete',
        'X=d; rm -rf "$X"*',
        // ranges next to commas, glob as a command
        "rm -rf {d,x}{o..o}cs",
        "rm -rf {x,d}o{c..c}s",
        "{r..r}m architecture.json",
        // long literal values stay whole
        `X="${pad} docs"; rm -rf $X`,
        `X="${pad} architecture.json"; rm $X`,
        `X="docs ${pad}"; rm -rf $X`,
        // glob and magic pathspecs after a rewind
        "git reset abc1234 && git checkout -- '*.json'",
        "git reset abc1234 && git checkout -- 'scri*'",
        "git reset abc1234 && git checkout -- './*'",
        "git reset abc1234 && git checkout -- '**'",
        "git reset abc1234 && git checkout -- ':(glob)**'",
        "git reset abc1234 && git checkout -- ':/*'",
        "git reset abc1234 && git checkout -- ':(top,glob)*'",
        "git reset abc1234 && git checkout -- d*",
        "git reset abc1234 && git restore -- '*.json'",
        "git reset abc1234 && git checkout -- ':(top)architecture.json'",
        // exclusions only, empty magic paths, icase, and the same without a reset
        "git reset abc1234 && git checkout -- ':!docs'",
        "git reset abc1234 && git checkout -- ':(exclude)docs'",
        "git reset abc1234 && git restore -- ':^src'",
        "git reset abc1234 && git checkout -- ':(glob)'",
        "git reset abc1234 && git checkout -- ':(icase)'",
        "git reset abc1234 && git checkout -- ':(literal).'",
        "git reset abc1234 && git checkout -- ':(icase)ARCHITECTURE.JSON'",
        "git reset abc1234 && git checkout -- ':(icase)Docs'",
        "git checkout HEAD~3 -- ':!src'",
        "git restore -s HEAD~3 -- ':!src'",
        "git checkout HEAD~3 -- ':(icase)ARCHITECTURE.JSON'",
        // whole tree by resolved path
        "git reset abc1234 && git checkout -- src/..",
        "git reset abc1234 && git checkout -- ./src/..",
        "git reset abc1234 && git checkout -- ':./'",
        "git reset abc1234 && git checkout -- ':(glob)./'",
        "git reset abc1234 && git checkout -- ':(top)./'",
        "git reset abc1234 && git checkout -- ':(glob)src/..'",
        "git checkout main -- src/..",
        "git checkout main -- ':./'",
        // printf
        `printf 'rm architecture.js'"on" | sh`,
        "X=$(printf 'architecture.%s' json); rm $X",
        "printf -v X 'architecture.%s' json; rm $X",
        'X=$(printf "docs"); rm -rf "$X"',
      ],
      [
        "rm -rf 'd*'",
        "rm -rf '*'",
        'rm -rf "*"',
        "rm -rf 'do'cx",
        "rm -rf {a,b}{1..3}x",
        "[ -f architecture.json ] && echo yes",
        `X="${pad}"; echo $X`,
        "git reset abc1234 && git checkout -- src/x.ts",
        "git reset abc1234 && git checkout -- 'src/*.ts'",
        "git checkout -- ':!src/x.ts' src",
        "git checkout -- src/x.ts",
        "git checkout main -- src/x.ts",
        "git checkout .",
        "git restore .",
        "git checkout -- ':(exclude)src'",
        "git reset abc1234 && git checkout -- ':!src/x.ts' src",
        "git checkout HEAD~3 -- ':(icase)SRC/X.TS'",
        "git checkout @{-1}",
        "git switch @{-1}",
        "X=$(printf 'a.%s' txt); echo $X architecture.json",
      ],
    );
  });
});

describe("guard decision: hardening follow-ups (#41)", () => {
  const cases = (blockedCmds: string[], allowedCmds: string[]) => {
    it.each(blockedCmds)("blocks %s", (cmd) => {
      expect(blocked(bash(cmd)), cmd).toBeDefined();
    });
    it.each(allowedCmds)("allows %s", (cmd) => {
      expect(bash(cmd), cmd).toEqual({ allow: true });
    });
  };

  describe("1. printf-variable check runs in linear time", () => {
    it("decides 1,800 printf names x 2,500 arguments well under a second", () => {
      const names = Array.from({ length: 1800 }, (_, i) => `V${i}=$(printf x)`).join("; ");
      const args = Array.from({ length: 2500 }, (_, i) => `a${i}`).join(" ");
      const cmd = `${names}; rm ${args}`;
      bash(cmd); // warm up
      const t0 = performance.now();
      const r = bash(cmd);
      const ms = performance.now() - t0;
      expect(r).toEqual({ allow: true });
      // Measured at ~1.4 s before the fix and well under 200 ms after; the bound is generous for CI.
      expect(ms).toBeLessThan(1000);
    });
    cases(
      ["X=$(printf docs); rm -rf $X", 'X=$(printf a); Y=$(printf %s "$X"); rm -rf ${Y}'],
      ["X=$(printf a); rm a.txt"],
    );
  });

  describe("2. git", () => {
    describe("bare HEAD is not a rewind (relaxed)", () => {
      cases(
        [
          "git checkout HEAD~1 -- .",
          "git reset abc1234 && git checkout HEAD -- .",
          "git checkout HEAD -- architecture.json",
          "git restore --source=HEAD~1 .",
          "git restore -s main .",
        ],
        [
          "git checkout HEAD -- .",
          "git checkout HEAD .",
          "git checkout @ -- .",
          "git checkout HEAD@{0} -- .",
          "git restore --source=HEAD .",
          "git restore -s @ .",
          "git checkout HEAD -- ':!src'",
        ],
      );
    });

    describe("cd into a folder narrows a whole-tree restore (R3: only when it surely ran)", () => {
      cases(
        [
          "cd docs && git checkout main -- .",
          "cd src && git checkout main -- ..",
          "cd src && git checkout main -- :/",
          "cd src && git checkout main -- ':/*'",
          "git checkout main -- .",
          // `;` runs the next command even when the cd failed
          "cd src; git checkout main -- .",
          "cd src; git checkout main -- ..",
          "cd zzz; git checkout main -- .",
          "cd src && true; git checkout main -- .",
          // a cd that may be skipped, or that runs in a subshell
          "true || cd src; git checkout main -- .",
          "false && cd src; git checkout main -- .",
          "cd src || git checkout main -- .",
          "(cd src); git checkout main -- .",
          "(cd src && true); git checkout main -- .",
          "(cd src && true) && git checkout main -- .",
          // operands that are not literal paths
          "cd src && cd - && git checkout main -- .",
          'cd src && cd "$OLDPWD" && git checkout main -- .',
          "cd src && cd ~- && git checkout main -- .",
          'cd src && cd "$(git rev-parse --show-toplevel)" && git checkout main -- .',
          "cd src && cd $(git rev-parse --show-toplevel) && git checkout main -- .",
          'cd "$PWD" && git checkout main -- .',
          "cd ~+ && git checkout main -- .",
          'cd "$(pwd)" && git checkout main -- .',
          // -C resolves cumulatively from where the cd chain got to
          'git -C "$PWD" checkout main -- .',
          'git -C "$(git rev-parse --show-toplevel)" checkout main -- .',
          "git -C src -C .. checkout main -- .",
          "cd src && git -C .. checkout main -- .",
          // anything that can redirect a cd turns narrowing off
          "CDPATH=..; cd proj && git checkout main -- .",
          "ln -s . s && cd s && git checkout main -- .",
          "pushd src && popd && git checkout main -- .",
          // the same for rm
          "cd src; rm -rf .",
          "cd zzz; rm -rf .",
          "true || cd src; rm -rf .",
          "(cd src); rm -rf .",
          'cd "$PWD" && rm -rf .',
          "cd src && cd - && rm -rf .",
          // decide() cannot see shell state (aliases, options, traps, sourced files, a cd in a function), so a whole-tree
          // restore is never decided on where a cd or -C seems to lead. The relaxation asked for in #41 was declined for that reason.
          "cd src && git checkout main -- .",
          "cd src && git restore -s main .",
          "cd src && cd lib && git checkout main -- .",
          "git -C src checkout main -- .",
          "git -C src -C lib checkout main -- .",
          "cd src && git -C lib checkout main -- .",
          "(cd src && git checkout main -- .)",
          "cd .. && git -C proj checkout main -- .",
        ],
        [
          "cd src && rm -rf .",
          "cd src && cd .. && cd lib && rm -rf .",
          'cd "$(pwd)/src" && rm -rf .',
          "(cd src && rm -rf .)",
          "pushd /tmp/x && rm -rf * && popd",
        ],
      );
      it("known limit: a symlink made by an earlier call is not seen", () => {
        // `ln -s . s` ran in a call of its own; decide() sees one call and cannot tell that `s` is the project root.
        expect(bash("cd s && rm -rf .")).toEqual({ allow: true });
        // A symlink made on the same line by code the guard does not read (`python3 -c "os.symlink('.', 's')"`) is the same.
        expect(bash(`python3 -c "import os; os.symlink('.', 's')" && cd s && rm -rf .`)).toEqual({
          allow: true,
        });
      });
    });

    describe("an exclusion pathspec without -- (blocked)", () => {
      cases(
        ["git checkout main ':!src'", "git checkout HEAD~3 ':(exclude)src'"],
        [
          "git checkout ':!src/x.ts' src",
          "git checkout main src/x.ts",
          "git checkout abc1234 src/x.ts",
        ],
      );
    });

    describe("upstream and reflog revisions (blocked)", () => {
      cases(
        [
          "git reset --keep @{u}",
          "git reset --hard HEAD@{1}",
          "git reset --hard @{upstream}",
          "git reset @{u} && git checkout -- .",
        ],
        [
          "git reset --hard HEAD@{0}",
          "git reset --keep HEAD~1",
          "git reset --hard HEAD^",
          "git reset --hard ORIG_HEAD",
        ],
      );
    });

    describe("short hex revisions (blocked, heuristic)", () => {
      cases(
        [
          "git checkout abc123",
          "git checkout ab12",
          "git switch --detach abc123",
          "git switch abc123",
        ],
        ["git checkout cafe", "git checkout 1234", "git checkout feat-1"],
      );
    });

    it("known limits: all-letter or all-digit short names and rewinds across calls", () => {
      // `face` / `decade` / `1234` may be branch names; telling them apart needs repo state.
      for (const cmd of ["git checkout face", "git checkout decade", "git checkout 123456"])
        expect(bash(cmd), cmd).toEqual({ allow: true });
      // decide() is pure and sees one call; the reset and the whole-tree checkout are each allowed alone.
      // Carrying state across calls would put I/O into the hook, and blocking every `checkout -- .` breaks "discard my changes".
      expect(bash("git reset abc1234")).toEqual({ allow: true });
      expect(bash("git checkout -- .")).toEqual({ allow: true });
    });
  });

  describe("3. paths at or above the project root", () => {
    cases(
      [
        "rm -rf ..",
        "rm -rf /",
        "find .. -delete",
        "find / -delete",
        "find / -name x -exec rm {} \\;",
        "rsync -a --delete src/ ..",
        "echo .. | xargs rm -rf",
        "chmod -R 000 ..",
        // $PWD and ~+ are the working directory
        'rm -rf "$PWD/docs"',
        "rm -rf ${PWD}/docs",
        "rm -rf ~+/docs",
        'find "$PWD" -delete',
        "rm -rf $PWD",
      ],
      [
        "rm -rf ../sibling",
        "rm -rf /tmp/x",
        "find /tmp/x -delete",
        "rm -rf ~/.cache/x",
        'rm -rf "$PWD/src/x"',
        'cd src && find "$PWD" -delete',
        "rsync -a src/ ..",
        "PWD=/tmp/x; rm -rf $PWD/docs",
      ],
    );

    it("blocks rm -rf ~ when the project lives under the home folder", () => {
      const under = (command: string) =>
        decide({
          tool: "Bash",
          input: { command },
          contract,
          root: "/home/u/proj",
          home: "/home/u",
        });
      expect(blocked(under("rm -rf ~")), "rm -rf ~").toBeDefined();
      expect(blocked(under("rm -rf ~/")), "rm -rf ~/").toBeDefined();
      expect(under("rm -rf ~/.cache/x")).toEqual({ allow: true });
      expect(under("rm -rf ~/other")).toEqual({ allow: true });
    });
  });

  describe("4. lexer: pattern groups and decoded text", () => {
    cases(
      [
        // bash extglob
        "rm -rf d@(ocs)",
        "rm -rf !(src)",
        "rm -rf +(d)ocs",
        "rm -rf *(/)",
        // zsh patterns
        "rm -rf (d|x)ocs",
        "rm arch(i|x)tecture.json",
        "rm -rf ^src",
        "rm -rf (#i)DOCS",
        // ANSI-C text run by a shell
        "echo $'rm\\x20architecture.json' | sh",
        "bash <<< $'rm\\x20architecture.json'",
      ],
      [
        "(cd src && rm -rf x)",
        "rm -rf src/@(a|b)",
        "echo (x)",
        "echo $'a\\tb'",
        "echo $'a\\tb' | sh",
        "f() { echo hi; }; f",
        "X=(a b); echo $X",
        "diff <(sort a) <(sort b)",
      ],
    );
  });

  describe("5. deletes and writes built at run time", () => {
    describe("a-c. command substitutions in operands", () => {
      cases(
        [
          "rm $(printf 'architecture.%s' json)",
          "rm -rf $(printf docs)",
          "rm $(echo architecture.json)",
          'rm -rf "$(printf do)cs"',
          "rm -rf $(echo d)*",
          "rm -rf `printf docs`",
          // a substitution whose output is not known, from printf or echo, in a delete
          'rm $(printf "%s" "$f")',
          "rm \"$(printf 'architecture.%s' json)\"",
          // unknown variables next to name text or a glob
          "rm -rf ${X:-d*}",
          "rm -rf ${X:-d}*",
          "rm -rf $X*",
          "rm -rf ${X}d*",
          // the substitution runs where the line has got to
          "cd docs && echo $(rm adr/0001-package-boundaries.md)",
        ],
        [
          "rm -rf $(mktemp -d)",
          "rm $(git ls-files -d)",
          "rm -rf $(ls -d src/*)",
          'rm "$(git ls-files -d)"',
          'rm "$(echo a.txt)"',
          "rm $(printf 'a.%s' txt)",
          "TMP=$(mktemp -d); rm -rf $TMP/*",
          'rm -rf "$TMP"',
          "X=src; rm -rf $X*",
        ],
      );
    });

    describe("d. printf variants and static values", () => {
      cases(
        [
          "X=$(command printf docs); rm -rf $X",
          "X=$(builtin printf docs); rm -rf $X",
          "X=$(/usr/bin/printf docs); rm -rf $X",
          "X=$(echo -e '\\x64ocs'); rm -rf $X",
          'X=$(command printf %s "$n"); rm -rf $X',
          // a static value is checked by the normal path rules
          "X=$(printf 'architecture.%s' json); cp /dev/null $X",
          "X=$(printf 'architecture.%s' json); echo > $X",
          "X=$(printf 'architecture.%s' json); echo hi | tee $X",
          "X=$(printf '%b' 'architecture.json'); touch $X",
          "X=$(printf '%d.json' 5); rm $X; rm architecture.json",
        ],
        [
          "X=$(printf 'a.%s' txt); rm $X",
          "X=$(printf 'a.%s' txt); echo $X architecture.json",
          "X=$(printf '%%'); rm a",
        ],
      );
      it("known limit: a non-literal printf variable that other writers use is allowed", () => {
        // `F=$(printf 'out-%s.log' "$n"); echo > $F` is a common legitimate pattern, and the value cannot be known.
        expect(bash(`F=$(printf 'out-%s.log' "$n"); echo > $F`)).toEqual({ allow: true });
        expect(bash(`F=$(printf 'out-%s.log' "$n"); cp /dev/null $F`)).toEqual({ allow: true });
      });
    });

    describe("e. printf and echo into xargs", () => {
      cases(
        [
          "printf 'architecture.json\\0' | xargs -0 rm",
          "printf 'docs\\n' | xargs rm -rf",
          'printf "%s\\n" "$f" | xargs rm',
          "echo -e 'docs\\n' | xargs rm -rf",
        ],
        [
          "printf 'a.txt\\0' | xargs -0 rm",
          "echo a.txt | xargs rm",
          'printf "%s\\n" "$f" | xargs grep x',
        ],
      );
    });

    describe("f. find into deleters", () => {
      cases(
        [
          "find . | xargs rm",
          "find . -print0 | xargs -0 rm -f",
          "find . -name '*.json' | xargs rm",
          "find . -exec sh -c 'rm \"$1\"' _ {} ;",
          "find docs | xargs rm",
          "find . | xargs -n 1 rm",
          "find . -exec bash -c 'rm -f \"$0\"' {} ;",
        ],
        [
          "find src | xargs rm",
          "find src -exec sh -c 'rm \"$1\"' _ {} ;",
          "find . -name '*.ts' | xargs grep x",
          "find . -exec sh -c 'echo \"$1\"' _ {} ;",
          "find . | xargs grep rm",
        ],
      );
    });

    describe("g. globs in other writers", () => {
      cases(
        [
          "truncate -s0 arch*.json",
          "cp /dev/null arch*.json",
          "chmod 000 arch*.json",
          "sed -i s/a/b/ bio*.json",
          "touch .githooks/*",
          // known side effect: consistent with the literal path, which is already blocked
          "chmod +x scripts/*.mjs",
          "cp -t arch*.json x",
        ],
        [
          "cp arch*.json /tmp/",
          "chmod +x src/*.sh",
          "sed -i s/a/b/ src/*.ts",
          "cp -t /tmp arch*.json",
          "touch src/*.ts",
        ],
      );
    });

    it("an echo or printf that is substituted into an interpreter's code is blocked by the interpreter rule", () => {
      for (const cmd of [
        `python3 -c "$(echo 'import os; os.remove("architecture.json")')"`,
        `node -e "$(echo "fs.rmSync('docs/adr/0001-package-boundaries.md')")"`,
      ])
        expect(blocked(bash(cmd)), cmd).toContain("protected path");
    });
  });

  describe("review fixes (R1-R7, S2-S4)", () => {
    describe("R1. pwd and the repository root are the working directory", () => {
      cases(
        [
          'rm -rf "$(pwd)"',
          "rm -rf $(pwd)",
          "rm -rf $(pwd -P)",
          'rm -rf "$(git rev-parse --show-toplevel)"',
          'cd "$(pwd)" && rm -rf *',
          'rm -rf "$(pwd)/docs"',
          'rm -rf "$(command pwd)/docs"',
          "rm -rf `pwd`/docs",
          "rm -rf `pwd`",
          'rm -rf "$(git rev-parse --show-toplevel)/docs"',
          'cd src && rm -rf "$(git rev-parse --show-toplevel)/docs"',
        ],
        [
          'rm -rf "$(pwd)/dist"',
          'rm -rf "$(pwd)"/dist',
          "rm -rf `pwd`/dist",
          'docker run --rm -v "$(pwd)":/app node:20 ls',
          'cd "$(git rev-parse --show-toplevel)" && pnpm test',
          'cd src && rm -rf "$(pwd)/x"',
        ],
      );
      it("expands $HOME like ~", () => {
        const under = (command: string) =>
          decide({
            tool: "Bash",
            input: { command },
            contract,
            root: "/home/u/proj",
            home: "/home/u",
          });
        for (const c of [
          'rm -rf "$HOME/proj/docs"',
          "rm -rf ${HOME}/proj/docs",
          "rm -rf $HOME",
          'rm -rf "$HOME"',
        ])
          expect(blocked(under(c)), c).toBeDefined();
        for (const c of ['rm -rf "$HOME/.cache/x"', "rm -rf ${HOME}/other"])
          expect(under(c), c).toEqual({ allow: true });
      });
    });

    describe("R2. a ( after time, coproc, case, ! or a function name is a subshell, not a pattern group", () => {
      cases(
        [
          "time (rm -rf docs)",
          "time ( rm -rf docs )",
          "time -p (rm -rf docs)",
          "time (rm -rf docs;)",
          "case x in (x) rm -rf docs;; esac",
          "coproc (rm -rf docs)",
          "! (rm -rf docs)",
          "if (rm -rf docs); then :; fi",
          "[[ -d src ]] && (rm -rf docs)",
          "f () (rm -rf docs); f",
          "f() (rm -rf docs); f",
          "function f (rm -rf docs); f",
          // a body with a space, ; or & is a subshell wherever it stands
          "make -C src (rm -rf docs)",
          "echo x (rm -rf docs; true)",
          // quotes inside a pattern group
          'rm -rf d@(o"c"s)',
          'rm -rf @("a b"|docs)',
        ],
        [
          "time (pnpm build)",
          "! (grep -q x file)",
          "rm -rf src/@(')')",
          "rm -rf src/@(a|b)",
          "echo hi | (cat)",
          "case $1 in (a) echo a;; esac",
        ],
      );
    });

    describe("R4. any move of HEAD or a branch makes a restore from HEAD a rewind", () => {
      cases(
        [
          "git reset --soft abc1234 && git checkout HEAD -- .",
          "git reset --soft abc1234 && git restore --source=HEAD --staged --worktree .",
          "git update-ref refs/heads/main abc1234 && git checkout HEAD -- .",
          "git update-ref HEAD abc1234 && git checkout HEAD -- .",
          "git symbolic-ref HEAD refs/heads/other && git checkout HEAD -- .",
          "git reset --soft abc1234 && git checkout -f",
          "git reset --soft abc1234 && git reset --hard",
        ],
        [
          "git reset --soft abc1234",
          "git reset --soft HEAD~1 && git checkout HEAD -- .",
          "git update-ref -d refs/heads/x && git checkout HEAD -- .",
          "git update-ref refs/tags/v1 abc1234 && git checkout HEAD -- .",
        ],
      );
    });

    describe("R5. printf and echo are evaluated only when the guard models them exactly", () => {
      cases(
        [
          "rm -rf \"$(printf '%b' 'docs\\cjunk')\"",
          "rm -rf $(echo -e 'docs\\cjunk')",
          "rm -rf $(echo -e '\\0144ocs')",
          "rm -rf \"$(printf '%b' '\\0144ocs')\"",
          "rm -rf \"$(printf '\\U64ocs')\"",
          "rm -rf \"$(printf '\\u0064ocs')\"",
          "rm -rf $(printf 'docs\\c')",
          "X=$(printf '%b' 'docs\\cjunk'); rm -rf $X",
          "X=$(echo -e '\\0144ocs'); rm -rf $X",
          "X=$(printf '\\U64ocs'); rm -rf \"$X\"",
          "X=$(printf '\\U64ocs'); rm -rf $X",
          // an echo without -e: bash prints the backslash, zsh decodes it
          "rm -rf $(echo '\\x64ocs')",
          // shadowed builtins and look-alikes
          "printf() { echo docs; }; X=$(printf safe); rm -rf $X",
          'printf() { echo docs; }; rm -rf "$(printf safe)"',
          'function printf { echo docs; }; rm -rf "$(printf safe)"',
          "alias printf='echo docs'; X=$(printf safe); rm -rf $X",
          "X=$(./printf safe); rm -rf $X",
          'rm -rf "$(./printf safe)"',
          'rm -rf "$(~/bin/echo safe)"',
          // unmodelled directives
          "rm -rf \"$(printf '%5s' safe)\"",
          "rm -rf \"$(printf '%q' safe)\"",
        ],
        [
          'rm "$(echo a.txt)"',
          "X=$(printf 'a.%s' txt); rm $X",
          "rm \"$(printf '%b' 'a\\tb')\"",
          'rm "$(/usr/bin/printf a.txt)"',
          "rm \"$(echo -e 'a\\x2etxt')\"",
          "rm \"$(printf 'a\\056txt')\"",
        ],
      );
    });

    describe("R6. long inputs are decided in bounded time", () => {
      const P = "(a=`".repeat(12_200);
      it.each([
        ["flat", `echo '${P}' printf`],
        ["nested", `A=$(B=$(C=$(echo '${P}' printf)))`],
        ["bash -c", `bash -c "bash -c \\"bash -c 'echo ${P} printf'\\""`],
        ["unbalanced groups", `rm ${"a(".repeat(24_000)}`],
      ])("%s", (_n, command) => {
        const t0 = performance.now();
        bash(command);
        // Over 1.5 s on main for the first two; a few ms now. The bound is generous for CI.
        expect(performance.now() - t0).toBeLessThan(3000);
      });
    });

    describe("R7. a literal U+E000 in the input", () => {
      it("does not crash and is checked like any other character", () => {
        for (const c of [
          "rm -rf \uE000$(printf docs)",
          "rm -rf $(printf docs)\uE000",
          "X=\uE000$(cat l); rm -rf $X",
          "rm -rf $'\\uE000'$(printf docs)",
          "echo \uE000",
        ])
          expect(() => bash(c), c).not.toThrow();
        expect(bash("rm -rf \uE000$(printf docs)")).toEqual({ allow: true });
        expect(blocked(bash("rm -rf $(printf docs)\uE000 docs"))).toBeDefined();
      });
    });

    describe("S2/S3. messages say what the command does", () => {
      it.each([
        ["chmod -R u+w .", "change the project root"],
        ["chown -R me .", "change the project root"],
        ["chgrp -R me docs", "change a folder"],
        ["mv . ../x", "delete or move the project root"],
        ["rm -rf ..", "delete or move the project root"],
        ["touch *", "in this write"],
        ["chmod 644 *", "in this write"],
        ["truncate -s0 arch*.json", "in this write"],
        ["chmod -R u+w d*", "in this write"],
        ["rm -rf d*", "in this delete or move"],
      ])("%s", (cmd, text) => {
        expect(blocked(bash(cmd)), cmd).toContain(text);
      });
    });

    describe("S4. the name given to checkout -b / switch -c is not a revision", () => {
      cases(
        [
          "git checkout -b feat abc123",
          "git switch -c feat abc123",
          "git checkout -B feat abc1234",
          "git checkout -b abc123 abc1234",
        ],
        [
          "git checkout -b abc123",
          "git checkout -B abc123",
          "git switch -c abc123",
          "git switch -C abc123",
          "git switch --create abc123",
          "git checkout --orphan abc123",
          "git checkout -b feat origin/main",
        ],
      );
    });
  });

  describe("second review (E1-E2, F1-F3, L-a, L-b)", () => {
    const a600 = "a".repeat(600);
    describe("E1. an echo with a backslash may be decoded by zsh", () => {
      cases(
        ["X=$(echo 'architecture\\x2ejson'); rm $X", "X=$(echo 'docs\\x2f'); rm -rf $X"],
        ["X=$(echo a.txt); rm $X"],
      );
    });

    it("E2. known limits: a cd target the guard cannot resolve widens a glob to the root (fail-closed)", () => {
      // `rm -rf *` in an unknown folder could be the project root, so these are blocked although they are often harmless.
      for (const c of [
        "cd $TMPDIR && rm -rf *",
        'TMP=$(mktemp -d) && cd "$TMP" && rm -rf *',
        'cd "$dir" && rm -rf ./*',
      ])
        expect(blocked(bash(c)), c).toBeDefined();
    });

    describe("F1. cd narrows only along an unbroken && chain", () => {
      cases(
        [
          "true || cd src && git checkout main -- .",
          "true || cd src && rm -rf .",
          "false || true || cd src && git checkout main -- .",
          "echo a; cd src && git checkout main -- .",
          "echo a | cat && cd src && git checkout main -- .",
          "pushd src && pushd +1 && git checkout main -- .",
          "pushd src && pushd -n .. && pushd +1 && git checkout main -- .",
          "cd src && cd src . && git checkout main -- .",
          "cd src && cd /src / && git checkout main -- .",
          "cd src && eval cd .. && git checkout main -- .",
          "cd src && source ./x.sh && git checkout main -- .",
          "cd src && . ./x.sh && git checkout main -- .",
          "up(){ cd ..; }; cd src && up && git checkout main -- .",
          "function up { cd ..; }; cd src && up && git checkout main -- .",
          "cd src && git --work-tree=.. checkout main -- .",
          "cd src && GIT_WORK_TREE=.. git checkout main -- .",
        ],
        ["echo a && cd src && rm -rf .", "cd src && cd lib && rm -rf .", "pushd src && rm -rf ."],
      );
    });

    describe("F2. a shadowed printf, echo or pwd is not evaluated", () => {
      cases(
        [
          "alias 'printf=echo docs'; X=$(printf safe); rm -rf $X",
          "alias -- printf='echo docs'; X=$(printf safe); rm -rf $X",
          "alias p=q printf='echo docs'; X=$(printf safe); rm -rf $X",
          "functions[printf]='echo docs'; X=$(printf safe); rm -rf $X",
          "\\printf() { echo docs; }; X=$(printf safe); rm -rf $X",
          'pwd() { echo docs; }; rm -rf "$(pwd)"',
          "echo () { echo docs; }; X=$(echo safe); rm -rf $X",
        ],
        ['rm "$(echo a.txt)"'],
      );
    });

    describe("F3. after a command name a ( is a pattern, and a body that could be a command list is checked as one too", () => {
      cases(
        [
          `rm -rf !(${a600}|src)`,
          `rm -rf @(${a600}|docs)`,
          "rm -rf (docs| x)",
          `chmod -R 000 !(${a600}|src)`,
          "nohup ({rm,-rf,docs})",
          "make -C src (rm -rf docs)",
          "echo x (rm -rf docs; true)",
          // L-a: more words after which a ( is a subshell
          "repeat 2 (rm -rf docs)",
          "foreach x (rm -rf docs)",
        ],
        ["rm -rf src/@(a|b)", "echo (x)"],
      );
    });

    it("L-b. known limit: a function the guard cannot see through", () => {
      // `f` can print anything; only printf, echo, pwd and git rev-parse are evaluated, and a substitution of any other
      // command is left as an unknown word.
      expect(bash('f(){ echo docs; }; rm -rf "$(f)"')).toEqual({ allow: true });
    });
  });

  describe("third review (D1, P1-P3)", () => {
    describe("D1. a cd that is not followed by a shell the guard can see does not narrow rm -rf .", () => {
      cases(
        [
          "cd src && builtin eval 'cd ..' && rm -rf .",
          "cd src && command eval 'cd ..' && rm -rf .",
          "x=eval && cd src && $x 'cd ..' && rm -rf .",
          "cd src && trap 'cd ..' DEBUG && rm -rf .",
          "pushd src && cd +1 && rm -rf .",
          "pushd src && pushd +1 && rm -rf .",
          "cd src && builtin source ./x && rm -rf .",
          "cd src && command . ./x && rm -rf .",
          "pushd src && popd && rm -rf .",
          "cd src && eval cd .. && rm -rf .",
        ],
        ["cd src && rm -rf .", "pushd /tmp/x && rm -rf * && popd"],
      );
      it("known limit: the git relaxations of #41 were declined", () => {
        // decide() cannot see shell state (aliases such as oh-my-zsh's `-`, options, traps, sourced files), so
        // `cd src && git checkout main -- .` stays blocked like `git checkout main -- .`. Bare HEAD is still allowed.
        for (const c of [
          "cd src && git checkout main -- .",
          "git -C src checkout main -- .",
          "cd .. && git -C proj checkout main -- .",
        ])
          expect(blocked(bash(c)), c).toBeDefined();
        expect(bash("cd src && git checkout HEAD -- .")).toEqual({ allow: true });
      });
    });

    describe("P1. shadowing is decided from the commands of the line", () => {
      cases(
        [
          "functions+=([printf]='echo docs'); X=$(printf safe); rm -rf $X",
          "functions[printf]='echo docs'; X=$(printf safe); rm -rf $X",
          ". ./f.sh; X=$(printf safe); rm -rf $X",
          'source ./f.sh && rm -rf "$(printf safe)"',
          "eval 'printf() { echo docs; }'; X=$(printf safe); rm -rf $X",
          "alias printf='echo docs'; X=$(printf safe); rm -rf $X",
        ],
        [
          'corepack enable && TMP=$(mktemp -d) && rm -rf "$TMP"',
          'git commit -m "add alias support" && TMP=$(mktemp -d); rm -rf $TMP',
          'cd apps/web && rm -rf * && git commit -m "call init()"',
          'git commit -m "call echo()" && X=$(mktemp -d); rm -rf $X',
        ],
      );
    });

    it("P3. known limit: a cd after a ; does not narrow", () => {
      // `nvm use` may fail and `;` runs the next command anyway, so `cd apps/web && rm -rf *` is read as a delete in the root.
      expect(blocked(bash("nvm use; cd apps/web && rm -rf *"))).toBeDefined();
      expect(bash("nvm use && cd apps/web && rm -rf *")).toEqual({ allow: true });
    });
  });
});
