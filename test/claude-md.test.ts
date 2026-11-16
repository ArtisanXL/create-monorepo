import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scaffold } from "../src/scaffold.ts";
import { fakeDeps, scaffoldOptions } from "./support/fixture.ts";

const execFileAsync = promisify(execFile);
const BEGIN = "<!-- scaffold:begin — managed by @artisanxl/create-monorepo -->";
const BASH_BEGIN = "<!-- scaffold:begin — managed by scaffold-monorepo.sh -->";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "claude-md-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const run = () => scaffold(scaffoldOptions(dir), fakeDeps());
const claude = () => readFile(join(dir, "CLAUDE.md"), "utf8");
const count = (text: string, needle: string) => text.split(needle).length - 1;
const generatedHash = async () =>
  (
    await execFileAsync("node", ["scripts/arch-check.mjs", "--claude-hash"], { cwd: dir })
  ).stdout.trim();
const recordedHash = async () =>
  JSON.parse(await readFile(join(dir, "architecture.json"), "utf8")).claude_md_block.sha256;

describe("CLAUDE.md block", () => {
  it("creates CLAUDE.md with the block and the new marker when absent", async () => {
    const result = await run();
    const text = await claude();
    expect(text.startsWith(`${BEGIN}\n# Project rules`)).toBe(true);
    expect(text.trimEnd().endsWith("<!-- scaffold:end -->")).toBe(true);
    expect(text).toContain("--filter @acme/<target>");
    expect(text).not.toMatch(/__[A-Z_]+__/);
    expect(result.written).toContain("CLAUDE.md");
  });

  it("appends once and preserves existing content", async () => {
    await writeFile(join(dir, "CLAUDE.md"), "# Mine\n\nKeep me.\n");
    await run();
    const first = await claude();
    expect(first.startsWith("# Mine\n\nKeep me.\n\n")).toBe(true);
    expect(count(first, "<!-- scaffold:begin")).toBe(1);

    const again = await run();
    expect(await claude()).toBe(first);
    expect(again.skipped).toContain("CLAUDE.md");
  });

  it("appends after content lacking a trailing newline", async () => {
    await writeFile(join(dir, "CLAUDE.md"), "# Mine");
    await run();
    expect((await claude()).startsWith(`# Mine\n\n${BEGIN}\n`)).toBe(true);
  });

  it("recognises a bash-era marker as already present", async () => {
    const old = `# Mine\n\n${BASH_BEGIN}\nold rules\n<!-- scaffold:end -->\n`;
    await writeFile(join(dir, "CLAUDE.md"), old);
    await run();
    expect(await claude()).toBe(old);
    expect(count(await claude(), "<!-- scaffold:begin")).toBe(1);
  });

  it("records a hash equal to the generated arch-check --claude-hash output", async () => {
    await run();
    expect(await recordedHash()).toMatch(/^[0-9a-f]{64}$/);
    expect(await recordedHash()).toBe(await generatedHash());
  });

  it("hashes the pre-existing block when architecture.json is missing", async () => {
    await writeFile(
      join(dir, "CLAUDE.md"),
      `# Mine\n\n${BASH_BEGIN}\nold rules\n<!-- scaffold:end -->\n`,
    );
    await run();
    expect(await recordedHash()).toBe(await generatedHash());
  });
});
