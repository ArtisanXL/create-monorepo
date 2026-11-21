import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { claudeBlockHash, hasBlock, upsertBlock } from "./claude-md.ts";
import type { Command, PackageManagerAdapter } from "./pm/types.ts";
import { catalogPackagesOf, listTemplateFiles, TEMPLATES_DIR } from "./templates.ts";

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

/** Literal replacement: a replacer function keeps `$&`, `$'` etc. in values from being interpreted. */
const sub = (text: string, token: string, value: string) => text.replaceAll(token, () => value);
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

type Values = ReadonlyArray<readonly [token: string, value: string]>;

/** The single template-filling path. Order matters: `__SCOPE_RE__` must precede `__SCOPE__`. */
export function fillTemplate(text: string, values: Values): string {
  return values.reduce((acc, [token, value]) => sub(acc, token, value), text);
}

function toRange(pkg: string, version: string): string {
  return `${pkg === "typescript" ? "~" : "^"}${version}`;
}

/** Read-only view of the target directory; lets planning run without touching disk. */
export interface TargetView {
  exists(rel: string): boolean | Promise<boolean>;
  read(rel: string): string | Promise<string>;
}

export function fsTargetView(target: string): TargetView {
  return {
    exists: (rel) => existsSync(join(target, rel)),
    read: (rel) => readFile(join(target, rel), "utf8"),
  };
}

/** The synchronous slice of the adapter that planning uses. */
export type PlanAdapter = Pick<
  PackageManagerAdapter,
  | "name"
  | "workspaceFile"
  | "renderWorkspaceFile"
  | "installCommand"
  | "formatCommand"
  | "verifyCommand"
>;

/** Everything the plan step needs; all I/O and network calls have already happened. */
export interface Gathered {
  options: Pick<Options, "scope" | "dbPrefix" | "nodeMajor" | "install">;
  pm: PlanAdapter;
  /** Value for package.json `packageManager`, already derived from the pm version. */
  packageManager: string;
  /** The target has its own `.git`. */
  hasGit: boolean;
  templates: { dest: string; text: string; executable: boolean }[];
  /** `claude-md/block.md`, unfilled. */
  blockText: string;
  /** Target paths that already exist (destinations, the workspace file, `.git`). */
  existing: ReadonlySet<string>;
  existingClaudeMd: string | undefined;
  /** Registry versions; only resolved when the workspace file is going to be written. */
  versions: Readonly<Record<string, string>> | undefined;
}

export interface PlannedFile {
  path: string;
  content: string;
  executable: boolean;
}

export interface PlannedCommand {
  command: Command;
  /** A non-zero exit is ignored. */
  tolerant: boolean;
}

export interface Plan {
  /** Files to write, sorted by path. */
  files: PlannedFile[];
  written: string[];
  skipped: string[];
  /** Run a best-effort `git init` before the commands. */
  gitInit: boolean;
  commands: PlannedCommand[];
}

/** Gather: all reads, network and pm calls happen here. Writes nothing and never calls `deps.run`. */
export async function gather(
  options: Options,
  deps: Pick<Deps, "resolveVersion" | "pm">,
  view: TargetView,
): Promise<Gathered> {
  const { pm } = deps;
  const templates = (await listTemplateFiles()).map(({ dest, text, executable }) => ({
    dest,
    text,
    executable,
  }));
  const blockText = await readFile(join(TEMPLATES_DIR, "claude-md", "block.md"), "utf8");

  const existing = new Set<string>();
  for (const rel of [...templates.map((t) => t.dest), pm.workspaceFile]) {
    if (await view.exists(rel)) existing.add(rel);
  }
  const existingClaudeMd = (await view.exists("CLAUDE.md"))
    ? await view.read("CLAUDE.md")
    : undefined;

  let versions: Record<string, string> | undefined;
  if (!existing.has(pm.workspaceFile)) {
    // `@types/node` follows the Node major, not the registry.
    const names = catalogPackagesOf(templates).filter((p) => p !== "@types/node");
    const resolved = await Promise.all(names.map((p) => deps.resolveVersion(p)));
    versions = {};
    names.forEach((p, i) => {
      (versions as Record<string, string>)[p] = resolved[i] as string;
    });
  }

  return {
    options: {
      scope: options.scope,
      dbPrefix: options.dbPrefix,
      nodeMajor: options.nodeMajor,
      install: options.install,
    },
    pm,
    packageManager: pm.packageManagerField(await pm.version()),
    hasGit: await view.exists(".git"),
    templates,
    blockText,
    existing,
    existingClaudeMd,
    versions,
  };
}

/** Plan: pure and synchronous. Decides every file, its content, and the commands to run. */
export function plan(g: Gathered): Plan {
  const { options, pm, existing, existingClaudeMd } = g;
  const { scope, dbPrefix, nodeMajor } = options;

  const claudeMdMissing = existingClaudeMd === undefined || !hasBlock(existingClaudeMd);
  const all = [
    ...g.templates.map((t) => t.dest),
    pm.workspaceFile,
    ...(claudeMdMissing ? ["CLAUDE.md"] : []),
  ].sort();
  const missing = all.filter((f) => f === "CLAUDE.md" || !existing.has(f));
  const skipped = [...all, ...(claudeMdMissing ? [] : ["CLAUDE.md"])]
    .filter((f) => !missing.includes(f))
    .sort();

  // Values are built in stages so the CLAUDE.md hash ordering is structural: the block is filled
  // without `__CLAUDE_SHA__`, hashed, and only then is the hash added for everything else.
  const baseValues: Values = [
    ["__DB_PREFIX__", dbPrefix],
    ["__SCOPE_RE__", escapeRegex(scope)],
    ["__SCOPE__", scope],
    ["__NODE_MAJOR__", String(nodeMajor)],
    ["__PACKAGE_MANAGER__", g.packageManager],
    ["__PM__", pm.name],
  ];
  const block = fillTemplate(g.blockText, baseValues);
  const claudeMd = upsertBlock(existingClaudeMd, block);
  const values: Values = [...baseValues, ["__CLAUDE_SHA__", claudeBlockHash(claudeMd) ?? ""]];

  const executable = new Set(g.templates.filter((t) => t.executable).map((t) => t.dest));
  const contents = new Map<string, string>();
  for (const t of g.templates) {
    if (missing.includes(t.dest)) contents.set(t.dest, fillTemplate(t.text, values));
  }
  if (claudeMdMissing) contents.set("CLAUDE.md", claudeMd);
  if (missing.includes(pm.workspaceFile)) {
    if (!g.versions)
      throw new Error("plan: workspace file is missing but no versions were gathered");
    const catalog: Record<string, string> = {};
    for (const [p, v] of Object.entries(g.versions)) catalog[p] = toRange(p, v);
    catalog["@types/node"] = `^${nodeMajor}`;
    const sorted = Object.fromEntries(Object.entries(catalog).sort(([a], [b]) => (a < b ? -1 : 1)));
    contents.set(pm.workspaceFile, pm.renderWorkspaceFile(sorted));
  }

  const commands: PlannedCommand[] = options.install
    ? [
        { command: pm.installCommand(), tolerant: false },
        ...(missing.length ? [{ command: pm.formatCommand(missing), tolerant: true }] : []),
        { command: pm.verifyCommand(), tolerant: false },
      ]
    : [];

  return {
    files: missing.map((path) => ({
      path,
      content: contents.get(path) as string,
      executable: executable.has(path),
    })),
    written: missing,
    skipped,
    // `git rev-parse` would succeed inside a parent repository and skip the init, leaving the
    // `prepare` script to set core.hooksPath on the parent: look for the target's own `.git`.
    gitInit: !g.hasGit,
    commands,
  };
}

/** Apply: the only step that writes files or spawns processes. */
export async function apply(p: Plan, target: string, deps: Pick<Deps, "run">): Promise<Result> {
  await mkdir(target, { recursive: true });
  for (const file of p.files) {
    const path = join(target, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content);
    if (file.executable) await chmod(path, 0o755);
  }

  if (p.gitInit) {
    try {
      await run(deps, ["git", "init", "-q", "-b", "main"], target);
    } catch {
      // A missing git binary must not fail a scaffold whose files are already written.
    }
  }

  for (const { command, tolerant } of p.commands) await run(deps, command, target, tolerant);

  return { written: p.written, skipped: p.skipped };
}

export async function scaffold(options: Options, deps: Deps): Promise<Result> {
  const gathered = await gather(options, deps, fsTargetView(options.target));
  return apply(plan(gathered), options.target, deps);
}

/** Runs a command and throws on failure unless `tolerant`. */
async function run(deps: Pick<Deps, "run">, command: Command, cwd: string, tolerant = false) {
  const [cmd, ...args] = command;
  const { code } = await deps.run(cmd, args, cwd);
  if (code !== 0 && !tolerant) throw new Error(`${command.join(" ")} failed (exit ${code})`);
}
