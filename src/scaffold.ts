import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeBlockHash, hasBlock, upsertBlock } from "./claude-md.ts";
import type { Command, PackageManagerAdapter } from "./pm/types.ts";

export interface Options {
  target: string;
  scope: string;
  dbPrefix: string;
  pm: string;
  install: boolean;
  nodeMajor: number;
}

export interface Deps {
  /** Returns the exact latest stable version of an npm package. */
  resolveVersion(pkg: string): Promise<string>;
  /** Runs a command in `cwd`; resolves with the exit code, rejects only if it cannot start. */
  run(cmd: string, args: readonly string[], cwd: string): Promise<{ code: number }>;
  pm: PackageManagerAdapter;
}

export interface Result {
  /** Paths relative to the target. */
  written: string[];
  skipped: string[];
}

/** Catalog packages, resolved from the registry. `@types/node` comes from the Node major. */
const CATALOG_PACKAGES = [
  "typescript",
  "@biomejs/biome",
  "turbo",
  "vitest",
  "tsx",
  "tsdown",
  "zod",
  "hono",
  "@hono/node-server",
  "@hono/zod-validator",
  "drizzle-orm",
  "drizzle-kit",
  "postgres",
  "pg-boss",
  "react",
  "react-dom",
  "@types/react",
  "@types/react-dom",
  "vite",
  "@vitejs/plugin-react",
  "@tanstack/react-query",
];

/** Generated files that must be executable. */
const EXECUTABLE = new Set([
  "scripts/worktree.mjs",
  "scripts/arch-check.mjs",
  ".claude/hooks/guard.mjs",
  ".claude/hooks/stop-check.mjs",
  ".githooks/pre-commit",
]);

const TEMPLATES_DIR = fileURLToPath(new URL("../templates/", import.meta.url));

/** Template files starting with `_` are dotfiles (npm would drop real ones when packing). */
function destinationOf(templatePath: string): string {
  return templatePath
    .split("/")
    .map((seg) => (seg.startsWith("_") ? `.${seg.slice(1)}` : seg))
    .join("/");
}

/** Template trees written into the target, in order. */
const TEMPLATE_TREES = ["root", "packages", "apps"] as const;

async function listTemplates(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listTemplates(dir, path)));
    else out.push(path);
  }
  return out.sort();
}

/** Literal replacement: a replacer function keeps `$&`, `$'` etc. in values from being interpreted. */
const sub = (text: string, token: string, value: string) => text.replaceAll(token, () => value);
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

const fill0 = (text: string, scope: string) => sub(text, "__SCOPE__", scope);

function toRange(pkg: string, version: string): string {
  return `${pkg === "typescript" ? "~" : "^"}${version}`;
}

export async function scaffold(options: Options, deps: Deps): Promise<Result> {
  const { target, scope, dbPrefix, nodeMajor } = options;
  const { pm } = deps;

  const templates: { src: string; dest: string }[] = [];
  for (const tree of TEMPLATE_TREES) {
    const prefix = tree === "root" ? "" : `${tree}/`;
    for (const rel of await listTemplates(join(TEMPLATES_DIR, tree))) {
      templates.push({
        src: join(TEMPLATES_DIR, tree, rel),
        dest: destinationOf(`${prefix}${rel}`),
      });
    }
  }
  const claudeMdPath = join(target, "CLAUDE.md");
  const existingClaudeMd = existsSync(claudeMdPath)
    ? await readFile(claudeMdPath, "utf8")
    : undefined;
  const claudeMdMissing = existingClaudeMd === undefined || !hasBlock(existingClaudeMd);
  const files = [
    ...templates.map((t) => t.dest),
    pm.workspaceFile,
    ...(claudeMdMissing ? ["CLAUDE.md"] : []),
  ].sort();
  const missing = files.filter((f) => f === "CLAUDE.md" || !existsSync(join(target, f)));
  const skipped = [...files, ...(claudeMdMissing ? [] : ["CLAUDE.md"])]
    .filter((f) => !missing.includes(f))
    .sort();

  // Everything that can fail on the network happens before the first write.
  const contents = new Map<string, string>();

  if (missing.includes(pm.workspaceFile)) {
    const versions = await Promise.all(CATALOG_PACKAGES.map((p) => deps.resolveVersion(p)));
    const catalog: Record<string, string> = {};
    CATALOG_PACKAGES.forEach((p, i) => {
      catalog[p] = toRange(p, versions[i] as string);
    });
    catalog["@types/node"] = `^${nodeMajor}`;
    contents.set(pm.workspaceFile, pm.renderWorkspaceFile(catalog));
  }

  // The CLAUDE.md block, then the hash recorded in architecture.json (same code as arch-check).
  const block = fill0(await readFile(join(TEMPLATES_DIR, "claude-md", "block.md"), "utf8"), scope);
  const claudeMd = upsertBlock(existingClaudeMd, block);
  if (claudeMdMissing) contents.set("CLAUDE.md", claudeMd);
  const claudeSha = claudeBlockHash(claudeMd) ?? "";

  const packageManager = pm.packageManagerField(await pm.version());
  const replacements: ReadonlyArray<readonly [string, string]> = [
    ["__DB_PREFIX__", dbPrefix],
    ["__SCOPE_RE__", escapeRegex(scope)],
    ["__SCOPE__", scope],
    ["__NODE_MAJOR__", String(nodeMajor)],
    ["__CLAUDE_SHA__", claudeSha],
    ["__PACKAGE_MANAGER__", packageManager],
    ["__PM__", pm.name],
  ];
  const fill = (text: string) => replacements.reduce((acc, [t, v]) => sub(acc, t, v), text);
  for (const t of templates) {
    if (missing.includes(t.dest)) contents.set(t.dest, fill(await readFile(t.src, "utf8")));
  }

  await mkdir(target, { recursive: true });
  for (const file of missing) {
    const path = join(target, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents.get(file) as string);
    if (EXECUTABLE.has(file)) await chmod(path, 0o755);
  }

  // `git rev-parse` would succeed inside a parent repository and skip the init, leaving the
  // `prepare` script to set core.hooksPath on the parent: look for the target's own `.git`.
  if (!existsSync(join(target, ".git"))) {
    try {
      await run(deps, ["git", "init", "-q", "-b", "main"], target);
    } catch {
      // A missing git binary must not fail a scaffold whose files are already written.
    }
  }

  if (options.install) {
    await run(deps, pm.installCommand(), target);
    // Formatting written files is best-effort.
    if (missing.length) await run(deps, pm.formatCommand(missing), target, true);
    await run(deps, pm.verifyCommand(), target);
  }

  return { written: missing, skipped };
}

/** Runs a command and throws on failure unless `tolerant`. */
async function run(deps: Deps, command: Command, cwd: string, tolerant = false) {
  const [cmd, ...args] = command;
  const { code } = await deps.run(cmd, args, cwd);
  if (code !== 0 && !tolerant) throw new Error(`${command.join(" ")} failed (exit ${code})`);
}
