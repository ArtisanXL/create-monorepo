
# --- Paseo + per-worktree isolation ----------------------------------------------------------
# Every git worktree (Paseo, Claude Code, manual) gets its own Postgres database. pg-boss keeps
# its queue in the same database, so jobs are isolated too. HTTP ports come from Paseo.
emit paseo.json <<'EOF'
{
  "worktree": {
    "setup": [
      "command -v pnpm >/dev/null || corepack enable --install-directory \"$HOME/.local/bin\" pnpm",
      "pnpm install --frozen-lockfile",
      "pnpm worktree:setup"
    ],
    "teardown": "pnpm worktree:teardown || true",
    "servicePorts": { "range": "4100-4999" }
  },
  "scripts": {
    "api": {
      "type": "service",
      "command": "PORT=$PASEO_PORT pnpm --filter __SCOPE__/api dev"
    },
    "web": {
      "type": "service",
      "command": "API_URL=http://127.0.0.1:$PASEO_SERVICE_API_PORT pnpm --filter __SCOPE__/web dev --host $HOST --port $PASEO_PORT --strictPort"
    },
    "worker": {
      "type": "service",
      "command": "pnpm --filter __SCOPE__/worker dev"
    },
    "test": { "command": "pnpm test" },
    "verify": { "command": "pnpm verify" },
    "db:migrate": { "command": "pnpm db:migrate" },
    "worktree:info": { "command": "pnpm worktree:info" }
  }
}
EOF

emit .worktreeinclude <<'EOF'
.env
EOF

emit scripts/worktree-lib.mjs <<'EOF'
// Pure helpers for scripts/worktree.mjs (unit-tested in worktree-lib.test.mjs).
import { createHash, randomBytes } from "node:crypto";
import { basename } from "node:path";
import { parseEnv } from "node:util";

/** `<slug>_<sha1(path)[:6]>`; slug = lowercased basename, `[^a-z0-9]` → `_`, max 20 chars. */
export function worktreeKey(worktreePath) {
  const slug = basename(worktreePath)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")
    .slice(0, 20);
  const hash = createHash("sha1").update(worktreePath).digest("hex").slice(0, 6);
  return `${slug}_${hash}`;
}

/** Database name for the main checkout (`key === null`) or a worktree. */
export function databaseName(prefix, key) {
  return key === null ? prefix : `${prefix}_wt_${key}`;
}

/** `url` with its database name replaced; `undefined` passes through. */
export function withDatabase(url, database) {
  if (url === undefined || url === "") return undefined;
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** Database name from a connection URL. */
export function databaseOf(url) {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}

export function setLine(text, key, value) {
  const line = new RegExp(`^${key}=.*$`, "m");
  if (line.test(text)) return text.replace(line, `${key}=${value}`);
  const base = text === "" || text.endsWith("\n") ? text : `${text}\n`;
  return `${base}${key}=${value}\n`;
}

/**
 * Points DATABASE_URL and WORKTREE_KEY at this checkout. A key is rewritten only while it is
 * missing or still equals the source checkout's value, so deliberate edits survive re-runs.
 */
export function rewriteIsolatedKeys(current, source, database, key) {
  const now = parseEnv(current);
  const src = parseEnv(source);
  const targets = {
    DATABASE_URL: withDatabase(now.DATABASE_URL ?? src.DATABASE_URL, database),
    WORKTREE_KEY: key ?? "",
  };
  let text = current;
  for (const [name, value] of Object.entries(targets)) {
    if (value === undefined) continue;
    if (now[name] === undefined || now[name] === src[name]) text = setLine(text, name, value);
  }
  return text;
}

/** Fills each listed key that is empty or still a `change-me` placeholder with 32 random bytes (hex). */
export function ensureSecrets(text, names) {
  const env = parseEnv(text);
  let result = text;
  for (const name of names) {
    const value = (env[name] ?? "").trim();
    if (value === "" || value.startsWith("change-me")) {
      result = setLine(result, name, randomBytes(32).toString("hex"));
    }
  }
  return result;
}
EOF

emit scripts/worktree-lib.test.mjs <<'EOF'
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import {
  databaseName,
  ensureSecrets,
  rewriteIsolatedKeys,
  withDatabase,
  worktreeKey,
} from "./worktree-lib.mjs";

describe("worktree-lib", () => {
  it("derives a stable, sanitized key from the worktree path", () => {
    const key = worktreeKey("/home/me/.paseo/worktrees/abc/Icky-Emu");
    expect(key).toMatch(/^icky_emu_[0-9a-f]{6}$/);
    expect(worktreeKey("/home/me/.paseo/worktrees/abc/Icky-Emu")).toBe(key);
    expect(worktreeKey("/other/Icky-Emu")).not.toBe(key);
  });

  it("names the main and worktree databases", () => {
    expect(databaseName("app", null)).toBe("app");
    expect(databaseName("app", "icky_emu_3f9a1c")).toBe("app_wt_icky_emu_3f9a1c");
  });

  it("replaces only the database in a URL", () => {
    expect(withDatabase("postgres://u:p@localhost:5432/app", "app_wt_k")).toBe(
      "postgres://u:p@localhost:5432/app_wt_k",
    );
  });

  it("rewrites isolated keys but keeps deliberate edits", () => {
    const source = "DATABASE_URL=postgres://u:p@h:5432/app\nAPI_KEY=secret\n";
    const fresh = parseEnv(rewriteIsolatedKeys(source, source, "app_wt_k", "k"));
    expect(fresh.DATABASE_URL).toBe("postgres://u:p@h:5432/app_wt_k");
    expect(fresh.WORKTREE_KEY).toBe("k");
    expect(fresh.API_KEY).toBe("secret");

    const edited = "DATABASE_URL=postgres://u:p@h:5432/custom\n";
    expect(parseEnv(rewriteIsolatedKeys(edited, source, "app_wt_k", "k")).DATABASE_URL).toBe(
      "postgres://u:p@h:5432/custom",
    );
  });

  it("fills empty and placeholder secrets only", () => {
    const text = "A=\nB=change-me-please\nC=keep\n";
    const env = parseEnv(ensureSecrets(text, ["A", "B", "C", "D"]));
    expect(env.A).toMatch(/^[0-9a-f]{64}$/);
    expect(env.B).toMatch(/^[0-9a-f]{64}$/);
    expect(env.C).toBe("keep");
    expect(env.D).toMatch(/^[0-9a-f]{64}$/);
  });
});
EOF

emit scripts/worktree.mjs <<'EOF'
#!/usr/bin/env node
/**
 * Per-worktree isolation on a shared local Postgres (see docs/adr/0004-worktree-isolation.md).
 *   pnpm worktree:setup     .env + database + migrations for this checkout (idempotent)
 *   pnpm worktree:teardown  drop this worktree's database (never the main checkout's; always exits 0)
 *   pnpm worktree:info      print the key and resource names
 *   pnpm worktree:gc [--yes] drop databases whose worktree folder no longer exists
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
  databaseOf,
  ensureSecrets,
  rewriteIsolatedKeys,
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

/** Where a missing .env is copied from, and what "unchanged" isolated values are compared to. */
function sourceEnvPath() {
  const candidates = [
    process.env.PASEO_SOURCE_CHECKOUT_PATH && join(process.env.PASEO_SOURCE_CHECKOUT_PATH, ".env"),
    join(mainCheckout, ".env"),
    join(toplevel, ".env.example"),
  ];
  for (const candidate of candidates) {
    if (candidate && candidate !== envPath && existsSync(candidate)) return candidate;
  }
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
    const result = spawnSync("pnpm", ["--silent", "--filter", DB_PACKAGE, "migrate"], {
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
  const protectedDbs = new Set([PREFIX]);
  const sourceEnv = process.env.PASEO_SOURCE_CHECKOUT_PATH
    ? join(process.env.PASEO_SOURCE_CHECKOUT_PATH, ".env")
    : join(mainCheckout, ".env");
  if (existsSync(sourceEnv)) {
    const url = parseEnv(readFileSync(sourceEnv, "utf8")).DATABASE_URL;
    if (url) protectedDbs.add(databaseOf(url));
  }
  if (!database.startsWith(`${PREFIX}_wt_`) || protectedDbs.has(database)) {
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
  const sql = adminSql(env);
  try {
    const rows = await sql`
      select datname, shobj_description(oid, 'pg_database') as comment
      from pg_database where datname like ${`${PREFIX}\\_wt\\_%`}`;
    const orphans = rows.filter(
      (r) => r.comment?.startsWith(COMMENT_PREFIX) && !existsSync(r.comment.slice(COMMENT_PREFIX.length)),
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
    [".env", existsSync(envPath) ? envPath : "(missing; run pnpm worktree:setup)"],
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
EOF
chmod +x scripts/worktree.mjs

emit docs/adr/0004-worktree-isolation.md <<'EOF'
# 0004. Per-worktree isolation (Paseo)

- Status: accepted

## Context
Agents and developers work in parallel git worktrees (Paseo, Claude Code, `git worktree add`).
Sharing one database or fixed ports between them causes collisions.

## Decision
- One shared local Postgres; isolation by name. The main checkout uses `__DB_PREFIX__`, every
  worktree `__DB_PREFIX___wt_<key>` (`<key>` = sanitized folder name + sha1 of the path).
  pg-boss stores its queue in the same database, so jobs are isolated too.
- `scripts/worktree.mjs` (`pnpm worktree:setup|teardown|info|gc`) writes `.env` (copied from the
  source checkout, only isolated keys rewritten, placeholder secrets generated), creates the
  database, runs migrations, and drops it again on teardown. It never touches the main checkout's
  database; teardown always exits 0.
- `paseo.json` runs setup/teardown and defines `api`, `web`, `worker` as services. Ports are
  assigned by Paseo (`servicePorts.range` 4100-4999) and never hard-coded; the web dev server
  proxies `/api` to `API_URL`. `.worktreeinclude` copies `.env` into new worktrees.
- Paseo reads `paseo.json` from the base branch: changes take effect after merging to main.

## Consequences
Worktrees removed outside Paseo leave databases behind; `pnpm worktree:gc --yes` drops them.
EOF
