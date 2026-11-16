import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const REPO_ROOT = resolve(import.meta.dirname, "../..");
export const BASH_SCRIPT = join(REPO_ROOT, "scaffold-monorepo.sh");

/** Bash parity runs shell tools (perl, GNU userland): Linux only. */
export const parityEnabled = process.platform === "linux";

export const FAKE_PM_VERSION = "9.9.9";
/** Deterministic fake registry: used by the pnpm shim and by the TS fake resolver. */
export const fakeVersion = (pkg: string) => `1.0.${pkg.length}`;

/**
 * Creates a directory holding a `pnpm` shim, to be prepended to PATH, so the bash script
 * resolves versions without a network: `pnpm -v` and `pnpm view <pkg> version`.
 */
export async function createPnpmShim(): Promise<string> {
  const bin = await mkdtemp(join(tmpdir(), "pnpm-shim-"));
  const shim = join(bin, "pnpm");
  await writeFile(
    shim,
    `#!/usr/bin/env bash
if [[ "$1" == "-v" ]]; then echo "${FAKE_PM_VERSION}"; exit 0; fi
if [[ "$1" == "view" && "$3" == "version" ]]; then echo "1.0.\${#2}"; exit 0; fi
echo "pnpm shim: unsupported args: $*" >&2; exit 1
`,
  );
  await chmod(shim, 0o755);
  return bin;
}

/** Runs the bash script with `--no-install` against `target`, using the shim. */
export async function runBash(target: string, shimDir: string, args: string[] = []) {
  await execFileAsync("bash", [BASH_SCRIPT, target, "--scope", "@acme", ...args, "--no-install"], {
    env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` },
  });
}

/**
 * Declared, allowed differences between bash and TS output. Each normaliser maps a file's
 * text to a canonical form on both sides before comparing.
 */
export const ALLOWED_DIFFERENCES: ReadonlyArray<{
  reason: string;
  normalise: (file: string, text: string) => string;
}> = [
  {
    reason: "CLAUDE.md begin marker names the tool that wrote it",
    normalise: (file, text) =>
      file === "CLAUDE.md"
        ? text.replace(/<!-- scaffold:begin — managed by [^>]*-->/, "<!-- scaffold:begin -->")
        : text,
  },
  {
    reason: "CLAUDE.md block hash is computed per implementation",
    normalise: (file, text) =>
      file === "architecture.json"
        ? text.replace(/"claudeSha256?":\s*"[0-9a-f]*"/, '"claudeSha":""')
        : text,
  },
  {
    reason: "package.json packageManager field is adapter-owned",
    normalise: (file, text) =>
      file === "package.json"
        ? text.replace(/"packageManager":\s*"[^"]*"/, '"packageManager": ""')
        : text,
  },
];

/** Reads each file from both trees, normalises, and returns the files that differ. */
export async function diffTrees(a: string, b: string, files: readonly string[]) {
  const differing: string[] = [];
  for (const f of files) {
    const [x, y] = await Promise.all([readFile(join(a, f), "utf8"), readFile(join(b, f), "utf8")]);
    const norm = (t: string) => ALLOWED_DIFFERENCES.reduce((acc, d) => d.normalise(f, acc), t);
    if (norm(x) !== norm(y)) differing.push(f);
  }
  return differing;
}
