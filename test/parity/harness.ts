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
 * Bugs inherited from the bash templates that the TS package fixes. Each entry is an exact
 * snippet: `normalise` rewrites the fixed snippet back to the original on both sides (a no-op
 * on the bash side), so every other byte of the file is still compared.
 */
const FIXED_BUGS: ReadonlyArray<{ file: string; reason: string; original: string; fixed: string }> =
  [
    {
      file: ".claude/hooks/stop-check.mjs",
      reason: "biome runs via its JS entry (the .bin shim cannot be spawned on Windows)",
      original: [
        `const biome = path.join(root, "node_modules", ".bin", "biome");`,
        `if (existsSync(biome)) checks.push(["lint", run(biome, ["check", "."])]);`,
      ].join("\n"),
      fixed: [
        "// node_modules/.bin/biome is a shell/cmd shim on Windows and cannot be spawned directly: run the",
        "// package's JS entry with this Node instead.",
        `const biome = path.join(root, "node_modules", "@biomejs", "biome", "bin", "biome");`,
        `if (existsSync(biome)) checks.push(["lint", run(process.execPath, [biome, "check", "."])]);`,
      ].join("\n"),
    },
    {
      file: "scripts/worktree-lib.mjs",
      reason: "setLine uses a replacer function so `$&` in a value is literal",
      original: String.raw`text.replace(line, \`\${key}=\${value}\`);`.replaceAll("\\", ""),
      fixed: String.raw`text.replace(line, () => \`\${key}=\${value}\`);`.replaceAll("\\", ""),
    },
    {
      file: "packages/contracts/src/index.ts",
      reason: "currency and locale are validated so Intl cannot throw a 500",
      original: [
        "  currency: z.string().length(3),",
        `  locale: z.string().min(2).default("en-US"),`,
      ].join("\n"),
      fixed: [
        `  currency: z.string().regex(/^[A-Za-z]{3}$/, "must be a 3-letter ISO 4217 code"),`,
        "  locale: z",
        "    .string()",
        "    .refine((v) => {",
        "      try {",
        "        return Intl.getCanonicalLocales(v).length === 1;",
        "      } catch {",
        "        return false;",
        "      }",
        `    }, "must be a valid BCP 47 locale")`,
        `    .default("en-US"),`,
      ].join("\n"),
    },
    {
      file: "apps/api/src/app.test.ts",
      reason: "extra test for the contracts validation fix",
      original: "    expect(res.status).toBe(400);\n  });\n});",
      fixed: [
        "    expect(res.status).toBe(400);",
        "  });",
        "",
        `  it("answers 400, not 500, for a malformed currency or locale", async () => {`,
        "    for (const body of [",
        `      { amount: "1", currency: "US1" },`,
        `      { amount: "1", currency: "USD", locale: "not a locale" },`,
        "    ]) {",
        `      const res = await app.request("/api/format-price", {`,
        `        method: "POST",`,
        `        headers: { "content-type": "application/json" },`,
        "        body: JSON.stringify(body),",
        "      });",
        "      expect(res.status).toBe(400);",
        "    }",
        "  });",
        "});",
      ].join("\n"),
    },
  ];

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
      file === "architecture.json" ? text.replace(/"sha256":\s*"[0-9a-f]*"/, '"sha256": ""') : text,
  },
  {
    reason: "TS records the chosen package manager in architecture.json",
    normalise: (file, text) =>
      file === "architecture.json" ? text.replace(/^\s*"package_manager":.*\n/m, "") : text,
  },
  ...FIXED_BUGS.map(({ file: target, reason, original, fixed }) => ({
    reason: `TS fixes a bash-inherited bug: ${reason}`,
    normalise: (file: string, text: string) =>
      file === target ? text.replaceAll(fixed, () => original) : text,
  })),
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
