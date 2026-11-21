#!/usr/bin/env node
/**
 * Per-worktree isolation on a shared local Postgres (see docs/adr/0004-worktree-isolation.md).
 *   __RUN__ worktree:setup     .env + database + migrations for this checkout (idempotent)
 *   __RUN__ worktree:teardown  drop this worktree's database (never the main checkout's; always exits 0)
 *   __RUN__ worktree:info      print the key and resource names
 *   __RUN__ worktree:gc [--yes] drop databases whose worktree folder no longer exists
 * Works in Paseo worktrees, Claude Code worktrees and plain `git worktree add` checkouts.
 * Prints resource names only, never secret values.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import postgres from "postgres";
import {
  databaseName,
  ensureSecrets,
  likePatternFor,
  mayDropDatabase,
  protectedDatabases,
  rewriteIsolatedKeys,
  sourceEnvCandidates,
  withDatabase,
  worktreeKey,
} from "./worktree-lib.mjs";

/** Every local database of this project starts with this prefix. */
const PREFIX = "__DB_PREFIX__";
/** .env keys generated per machine when empty or still a `change-me` placeholder. */
const GENERATED_SECRETS = [];
const DB_PACKAGE = "__SCOPE__/db";
const COMMENT_PREFIX = "worktree:";

const log = (message) => console.log(`worktree: ${message}`);
const warn = (message) => console.warn(`worktree: WARNING: ${message}`);
const errorText = (error) => (error instanceof Error ? error.message : String(error));
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

const toplevel = realpathSync(git("rev-parse", "--show-toplevel"));
const commonDir = realpathSync(git("rev-parse", "--path-format=absolute", "--git-common-dir"));
const isMain = commonDir === join(toplevel, ".git");
const mainCheckout = dirname(commonDir);
const key = isMain ? null : worktreeKey(toplevel);
const database = databaseName(PREFIX, key);
const envPath = join(toplevel, ".env");

const readEnv = () => (existsSync(envPath) ? parseEnv(readFileSync(envPath, "utf8")) : {});

function adminSql(env) {
  const url = withDatabase(env.DATABASE_URL, "postgres");
  if (!url) throw new Error("DATABASE_URL is missing from .env");
  return postgres(url, { max: 1, onnotice: () => {} });
}

function existingSourceEnvs({ excludeOwn }) {
  return sourceEnvCandidates({
    paseoSource: process.env.PASEO_SOURCE_CHECKOUT_PATH,
    mainCheckout,
    toplevel,
  }).filter((candidate) => !(excludeOwn && candidate === envPath) && existsSync(candidate));
}

/** Databases named by any existing source .env; throws on a malformed URL so callers fail closed. */
function protectedSourceDatabases() {
  return protectedDatabases({
    prefix: PREFIX,
    envs: existingSourceEnvs({ excludeOwn: false }).map((source) => ({
      source,
      text: readFileSync(source, "utf8"),
    })),
  });
}

/** Where a missing .env is copied from, and what "unchanged" isolated values are compared to. */
function sourceEnvPath() {
  const found = existingSourceEnvs({ excludeOwn: true });
  if (found.length > 0) return found[0];
  throw new Error("no .env source found (expected .env.example at least)");
}

/** mkdir-based lock in the shared git dir so concurrent setups (Paseo + hooks) do not race. */
async function withLock(fn) {
  const lock = join(commonDir, "worktree-setup.lock");
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      const stale = existsSync(lock) && Date.now() - statSync(lock).mtimeMs > 10 * 60_000;
      if (stale) rmSync(lock, { recursive: true, force: true });
      else if (attempt > 120) throw new Error(`could not acquire ${lock}`);
      else await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

async function setup() {
  const source = sourceEnvPath();
  if (!existsSync(envPath)) {
    copyFileSync(source, envPath);
    log(`.env copied from ${source}`);
  }
  const current = readFileSync(envPath, "utf8");
  const next = ensureSecrets(
    rewriteIsolatedKeys(current, readFileSync(source, "utf8"), database, key),
    GENERATED_SECRETS,
  );
  if (next !== current) writeFileSync(envPath, next);
  chmodSync(envPath, 0o600);
  const env = readEnv();

  const sql = adminSql(env);
  try {
    const [exists] = await sql`select 1 from pg_database where datname = ${database}`;
    if (!exists) {
      await sql`create database ${sql(database)}`;
      log(`created database ${database}`);
    }
    const comment = `${COMMENT_PREFIX}${toplevel}`.replaceAll("'", "''");
    await sql.unsafe(`comment on database "${database}" is '${comment}'`);
  } finally {
    await sql.end();
  }

  if (existsSync(join(toplevel, "packages", "db", "migrations"))) {
    const result = spawnSync("__PM__", ["--silent", "--filter", DB_PACKAGE, "migrate"], {
      cwd: toplevel,
      env: { ...process.env, DATABASE_URL: env.DATABASE_URL },
      stdio: ["ignore", "ignore", "inherit"],
    });
    if (result.status !== 0) throw new Error(`migrations failed on ${database}`);
    log(`${database}: migrated`);
  } else {
    log(`${database}: no migrations yet`);
  }
  info();
}

async function teardown() {
  if (key === null) return warn("refusing to tear down the main checkout");
  const env = readEnv();
  const protectedDbs = protectedSourceDatabases();
  if (!mayDropDatabase({ prefix: PREFIX, database, protected: protectedDbs })) {
    return warn(`refusing: ${database} belongs to the main or source checkout`);
  }
  const sql = adminSql(env);
  try {
    await sql`drop database if exists ${sql(database)} with (force)`;
    log(`dropped database ${database} (if it existed)`);
  } finally {
    await sql.end();
  }
}

async function gc(confirmed) {
  const env = readEnv();
  const protectedDbs = protectedSourceDatabases();
  const sql = adminSql(env);
  try {
    const rows = await sql`
      select datname, shobj_description(oid, 'pg_database') as comment
      from pg_database where datname like ${likePatternFor(PREFIX)}`;
    const orphans = rows.filter(
      (r) =>
        mayDropDatabase({ prefix: PREFIX, database: r.datname, protected: protectedDbs }) &&
        r.comment?.startsWith(COMMENT_PREFIX) &&
        !existsSync(r.comment.slice(COMMENT_PREFIX.length)),
    );
    if (orphans.length === 0) return log("no orphaned worktree databases");
    for (const r of orphans) log(`orphaned: ${r.datname} (${r.comment.slice(COMMENT_PREFIX.length)} is gone)`);
    if (!confirmed) return log("re-run with --yes to drop them");
    for (const r of orphans) {
      await sql`drop database if exists ${sql(r.datname)} with (force)`;
      log(`dropped database ${r.datname}`);
    }
  } finally {
    await sql.end();
  }
}

function info() {
  const lines = [
    ["checkout", isMain ? `${toplevel} (main)` : toplevel],
    ["key", key ?? "(main checkout)"],
    ["database", database],
    [".env", existsSync(envPath) ? envPath : "(missing; run __RUN__ worktree:setup)"],
  ];
  for (const [label, value] of lines) console.log(`${`${label}:`.padEnd(10)} ${value}`);
}

const [command, ...flags] = process.argv.slice(2);
switch (command) {
  case "setup":
    await withLock(setup);
    break;
  case "teardown":
    try {
      await teardown();
    } catch (error) {
      warn(errorText(error));
    }
    process.exit(0);
    break;
  case "gc":
    await gc(flags.includes("--yes"));
    break;
  case "info":
    info();
    break;
  default:
    console.error("usage: worktree <setup|teardown|info|gc [--yes]>");
    process.exit(2);
}
