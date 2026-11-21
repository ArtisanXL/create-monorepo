import { claudeBlockHash, DEFAULT_MARKERS } from "../templates/root/scripts/arch-contract.mjs";

export { claudeBlockHash };

/** Prefix shared by every marker generation; its presence means "block already there". */
export const BLOCK_MARKER_PREFIX = DEFAULT_MARKERS.begin;
export const BLOCK_BEGIN = "<!-- scaffold:begin — managed by @artisanxl/create-monorepo -->";
export const BLOCK_END = DEFAULT_MARKERS.end;

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
