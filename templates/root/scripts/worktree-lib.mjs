// Pure helpers for scripts/worktree.mjs (unit-tested in worktree-lib.test.mjs).
import { createHash, randomBytes } from "node:crypto";
import { basename, join } from "node:path";
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

/** Separates the project prefix from the worktree key in every worktree database name. */
export const WORKTREE_SEPARATOR = "_wt_";

/** Database name for the main checkout (`key === null`) or a worktree. */
export function databaseName(prefix, key) {
  return key === null ? prefix : `${prefix}${WORKTREE_SEPARATOR}${key}`;
}

/** True only for a database named `<prefix>_wt_<something>`; a literal comparison, no wildcards. */
export function isWorktreeDatabase(prefix, name) {
  const head = `${prefix}${WORKTREE_SEPARATOR}`;
  return typeof name === "string" && name.length > head.length && name.startsWith(head);
}

/** SQL LIKE pattern (default `\` escape) matching worktree databases of `prefix`; `\`, `%`, `_` are literal. */
export function likePatternFor(prefix) {
  const literal = `${prefix}${WORKTREE_SEPARATOR}`.replace(/[\\%_]/g, "\\$&");
  return `${literal}%`;
}

/** Ordered `.env` sources: Paseo source checkout, main checkout, then this checkout's `.env.example`. */
export function sourceEnvCandidates({ paseoSource, mainCheckout, toplevel }) {
  return [
    ...(paseoSource ? [join(paseoSource, ".env")] : []),
    join(mainCheckout, ".env"),
    join(toplevel, ".env.example"),
  ];
}

/** Databases that must never be dropped: the bare prefix plus each env text's DATABASE_URL database. */
export function protectedDatabases({ prefix, envTexts }) {
  const names = new Set([prefix]);
  for (const text of envTexts) {
    const url = parseEnv(text).DATABASE_URL;
    if (!url) continue;
    try {
      names.add(databaseOf(url));
    } catch {
      // an unparseable URL names no database
    }
  }
  return names;
}

/** Drop-safety rule: only this project's worktree databases that are not protected. */
export function mayDropDatabase({ prefix, database, protected: protectedNames }) {
  return isWorktreeDatabase(prefix, database) && !protectedNames.has(database);
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
  if (line.test(text)) return text.replace(line, () => `${key}=${value}`);
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
