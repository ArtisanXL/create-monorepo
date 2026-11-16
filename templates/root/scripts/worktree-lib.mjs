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
