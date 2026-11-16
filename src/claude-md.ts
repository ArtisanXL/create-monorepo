import { createHash } from "node:crypto";

/** Prefix shared by every marker generation; its presence means "block already there". */
export const BLOCK_MARKER_PREFIX = "<!-- scaffold:begin";
export const BLOCK_BEGIN = "<!-- scaffold:begin — managed by @artisanxl/create-monorepo -->";
export const BLOCK_END = "<!-- scaffold:end -->";

export function hasBlock(text: string): boolean {
  return text.includes(BLOCK_MARKER_PREFIX);
}

/**
 * Returns `existing` with the rules block appended once (existing content preserved).
 * Already-present blocks, including bash-era markers, are left untouched.
 */
export function upsertBlock(existing: string | undefined, block: string): string {
  if (existing !== undefined && hasBlock(existing)) return existing;
  const wrapped = `${BLOCK_BEGIN}\n${block.replace(/\n+$/, "")}\n${BLOCK_END}\n`;
  if (!existing) return wrapped;
  const lead = existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${lead}${wrapped}`;
}

/**
 * sha256 of the scaffold block, markers included; null when absent. Must stay identical to
 * `claudeBlockHash` in templates/root/scripts/arch-check.mjs (a test pins the equality).
 */
export function claudeBlockHash(text: string): string | null {
  const normalised = text.replace(/\r\n/g, "\n");
  const b = normalised.indexOf(BLOCK_MARKER_PREFIX);
  const e = b < 0 ? -1 : normalised.indexOf(BLOCK_END, b);
  if (e < 0) return null;
  return createHash("sha256")
    .update(normalised.slice(b, e + BLOCK_END.length))
    .digest("hex");
}
