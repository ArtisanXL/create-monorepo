import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CANCEL, type FsProbe, OptionsError, type Prompter, USAGE } from "../src/options.ts";
import { type RunIo, run } from "../src/run.ts";
import type { Deps } from "../src/scaffold.ts";
import { fakeDeps } from "./support/fixture.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "run-test-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const probe: FsProbe = { exists: async () => false, isNonEmptyDir: async () => false };

function harness(over: Partial<RunIo> = {}) {
  let stdout = "";
  let stderr = "";
  const asked: string[] = [];
  const ask = async (message: string): Promise<typeof CANCEL> => {
    asked.push(message);
    return CANCEL;
  };
  const prompter: Prompter = { text: ask, select: ask, confirm: ask };
  const io: RunIo = {
    argv: [dir, "--no-install", "-y"],
    env: {},
    tty: false,
    nodeVersion: "24.0.0",
    prompter,
    fsProbe: probe,
    makeDeps: () => fakeDeps(),
    stdout: {
      write: (t) => {
        stdout += t;
      },
    },
    stderr: {
      write: (t) => {
        stderr += t;
      },
    },
    ...over,
  };
  return { io, asked, out: () => stdout, err: () => stderr };
}

describe("run", () => {
  it("prints usage on --help, even on an old Node", async () => {
    const h = harness({ argv: ["--help"], nodeVersion: "18.0.0" });
    expect(await run(h.io)).toBe(0);
    expect(h.out()).toContain(USAGE);
  });

  it("returns 1 with usage on an unknown flag", async () => {
    const h = harness({ argv: ["x", "--bogus"] });
    expect(await run(h.io)).toBe(1);
    expect(h.err()).toContain(USAGE);
  });

  it("fails on an old Node before prompting", async () => {
    const h = harness({ argv: [], tty: true, nodeVersion: "22.0.0" });
    expect(await run(h.io)).toBe(1);
    expect(h.err()).toContain("Node >= 24 required");
    expect(h.asked).toEqual([]);
  });

  it("exits 0 and writes nothing when the user cancels", async () => {
    const h = harness({ argv: [dir], tty: true });
    expect(await run(h.io)).toBe(0);
    expect(h.err()).toContain("Cancelled. No files were written.");
    expect(await readdir(dir)).toEqual([]);
  });

  it("returns the exit code of an OptionsError", async () => {
    const h = harness({ argv: [] });
    expect(await run(h.io)).toBe(new OptionsError("").exitCode);
    expect(h.err()).toContain("Missing <target-dir>");
  });

  it("returns 1 when scaffolding fails", async () => {
    const failing = (): Deps => ({
      ...fakeDeps(),
      resolveVersion: async () => {
        throw new Error("registry down");
      },
    });
    const h = harness({ makeDeps: failing });
    expect(await run(h.io)).toBe(1);
    expect(h.err()).toContain("registry down");
  });

  it("prints the report and next steps on success", async () => {
    const h = harness();
    expect(await run(h.io)).toBe(0);
    expect(h.out()).toContain(`Scaffold ready: ${dir}`);
    expect(h.out()).toContain("Next steps:");
  });
});
