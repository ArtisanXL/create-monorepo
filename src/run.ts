import { type Closure, closureOf } from "./components.ts";
import type { ResolvedOptions } from "./options.ts";
import {
  CancelledError,
  type FsProbe,
  OptionsError,
  type Prompter,
  parseCli,
  resolveOptions,
  USAGE,
} from "./options.ts";
import { type Deps, type Result, scaffold } from "./scaffold.ts";

export interface RunIo {
  argv: readonly string[];
  env: Record<string, string | undefined>;
  tty: boolean;
  nodeVersion: string;
  prompter: Prompter;
  fsProbe: FsProbe;
  makeDeps(resolved: ResolvedOptions): Deps;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
}

const MIN_NODE_MAJOR = 24;

function formatResult(result: Result, target: string, nextSteps: string): string {
  return [
    ...result.written.map((f) => `  + ${f}`),
    ...result.skipped.map((f) => `  = ${f} (exists, skipped)`),
    "",
    `Scaffold ready: ${target}  (${result.written.length} new files)`,
    "",
    nextSteps,
  ].join("\n");
}

function nextSteps(run: string, closure: Closure): string {
  const servers = [
    closure.has("api") && "api :3000",
    closure.has("web") && "web :5173",
    closure.has("worker") && "worker",
  ].filter(Boolean);
  return [
    "Next steps:",
    closure.has("db") && "  cp .env.example .env && docker compose up -d",
    servers.length > 0 && `  ${`${run} dev`.padEnd(31)}# ${servers.join(", ")}`,
    `  ${".github/CODEOWNERS".padEnd(31)}# assign owners for architecture files`,
    '  git add -A && git commit -m "chore: scaffold"',
  ]
    .filter(Boolean)
    .join("\n");
}

/** Runs the CLI end to end and returns the process exit code. */
export async function run(io: RunIo): Promise<number> {
  const out = (text: string) => io.stdout.write(`${text}\n`);
  const err = (text: string) => io.stderr.write(`${text}\n`);
  try {
    const parsed = parseCli(io.argv);
    if (parsed.values.help) {
      out(USAGE);
      return 0;
    }

    const nodeMajor = Number(io.nodeVersion.split(".")[0]);
    if (nodeMajor < MIN_NODE_MAJOR) {
      err(`Node >= ${MIN_NODE_MAJOR} required (found: ${nodeMajor})`);
      return 1;
    }

    const resolved = await resolveOptions(parsed, io.env, io.tty, io.prompter, io.fsProbe);
    const deps = io.makeDeps(resolved);
    const result = await scaffold({ ...resolved, nodeMajor }, deps);
    const steps = nextSteps(deps.pm.commands.run.join(" "), closureOf(resolved.selection));
    out(formatResult(result, resolved.target, steps));
    return 0;
  } catch (error) {
    if (error instanceof CancelledError) {
      err("Cancelled. No files were written.");
      return 0;
    }
    err(error instanceof Error ? error.message : String(error));
    return error instanceof OptionsError ? error.exitCode : 1;
  }
}
