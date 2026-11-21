// The single interpreter of architecture.json. Dependency-free (Node built-ins only); imported by
// the guard hook, arch-check and the scaffolder. Under scripts/, so it is protected like them.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

/** Marker prefixes that bound the CLAUDE.md scaffold block. */
export const DEFAULT_MARKERS = Object.freeze({
  begin: "<!-- scaffold:begin",
  end: "<!-- scaffold:end -->",
});

/** Folders that hold workspace packages. */
export const PACKAGE_GROUPS = Object.freeze(["apps", "packages"]);

/**
 * @typedef {{ name: string, path?: string, trigger?: string, deps?: string[] }} Deferred
 * @typedef {{ begin: string, end: string, sha256?: string }} BlockMarkers
 * @typedef {ReturnType<typeof contractFrom>} Contract
 */

/**
 * Applies defaults to a parsed architecture.json. Pure.
 * @param {any} json
 */
export function contractFrom(json) {
  /** @type {Record<string, any>} */
  const packages = json.packages ?? {};
  /** @type {Deferred[]} */
  const deferred = json.deferred ?? [];
  return {
    scope: /** @type {string | undefined} */ (json.scope),
    packages,
    deferred,
    protectedPaths: /** @type {string[]} */ (json.protected_paths ?? []),
    exceptions: /** @type {string[]} */ (json.agent_writable_exceptions ?? []),
    testAllow: /** @type {string[]} */ (json.test_allow ?? []),
    packageManager: /** @type {string | undefined} */ (json.package_manager),
    claudeBlock: /** @type {BlockMarkers | undefined} */ (json.claude_md_block),
  };
}

/** @param {string} root */
export function loadContract(root) {
  return contractFrom(JSON.parse(readFileSync(path.join(root, "architecture.json"), "utf8")));
}

/**
 * Whether a root-relative, forward-slash path is off limits to agents.
 * @param {Contract} contract
 * @param {string} rel
 */
export function isProtected(contract, rel) {
  return (
    !contract.exceptions.some((e) => rel.startsWith(e)) &&
    contract.protectedPaths.some((p) => (p.endsWith("/") ? rel.startsWith(p) : rel === p))
  );
}

/** Like isProtected, but a protected folder itself (`docs/adr`) counts too. */
export function isProtectedOrDir(contract, rel) {
  return (
    isProtected(contract, rel) ||
    contract.protectedPaths.some((p) => p.endsWith("/") && rel === p.slice(0, -1))
  );
}

/**
 * Which package folder owns a root-relative path; null when it is not under apps/ or packages/.
 * @param {Contract} contract
 * @param {string} rel
 * @returns {{ dir: string, declared: boolean, deferred: Deferred | undefined } | null}
 */
export function packageOf(contract, rel) {
  const m = rel.match(/^(apps|packages)\/([^/]+)/);
  if (!m) return null;
  const dir = `${m[1]}/${m[2]}`;
  return {
    dir,
    declared: Object.hasOwn(contract.packages, dir),
    deferred: contract.deferred.find((d) => d.path === dir),
  };
}

/** The deferred entry that lists `dep` as a forbidden dependency, if any. */
export function deferredOfDep(contract, dep) {
  return contract.deferred.find((d) => (d.deps ?? []).includes(dep));
}

const esc = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * A deferred dependency named (optionally with a version) in a shell command.
 * @returns {{ dep: string, deferred: Deferred } | undefined}
 */
export function deferredDepInCommand(contract, cmd) {
  for (const d of contract.deferred)
    for (const dep of d.deps ?? [])
      if (new RegExp(`(^|[\\s"'])${esc(dep)}(@[^\\s"']*)?(?=$|[\\s"'])`).test(cmd))
        return { dep, deferred: d };
  return undefined;
}

/**
 * Deferred dependencies declared as keys in a __CATALOG_FILE__ catalog.
 * @returns {{ dep: string, deferred: Deferred }[]}
 */
export function deferredDepsInCatalog(contract, text) {
  const found = [];
  for (const d of contract.deferred)
    for (const dep of d.deps ?? [])
      if (new RegExp(`^\\s+["']?${esc(dep)}["']?\\s*:`, "m").test(text)) found.push({ dep, deferred: d });
  return found;
}

/** @param {Deferred} d */
export function deferredHint(d) {
  return `This is deferred "${d.name}" (trigger: ${d.trigger}). If you think it is needed, stop, write an ADR draft under docs/adr/proposed/ and ask the user.`;
}

/**
 * Location of the scaffold block (markers included) in the caller's own text, so the positions
 * line up with that text whatever its line endings.
 * @param {string} text
 * @param {{ begin: string, end: string }} [markers]
 * @returns {{ start: number, end: number } | null}
 */
export function claudeBlockSpan(text, markers = DEFAULT_MARKERS) {
  const start = text.indexOf(markers.begin);
  const e = start < 0 ? -1 : text.indexOf(markers.end, start);
  return e < 0 ? null : { start, end: e + markers.end.length };
}

/**
 * sha256 of the block with LF endings, so a CRLF checkout hashes the same; null when absent.
 * @param {string} text
 * @param {{ begin: string, end: string }} [markers]
 */
export function claudeBlockHash(text, markers = DEFAULT_MARKERS) {
  const lf = text.replace(/\r\n/g, "\n");
  const span = claudeBlockSpan(lf, markers);
  return span ? createHash("sha256").update(lf.slice(span.start, span.end)).digest("hex") : null;
}
