import { readFileSync } from "node:fs";
import { claudeBlockHash, contractFrom } from "../../templates/root/scripts/arch-contract.mjs";

export const BLOCK_BODY =
  "<!-- scaffold:begin — test -->\n# Project rules\nbody\n<!-- scaffold:end -->";
export const CLAUDE_MD = `# Mine\n\n${BLOCK_BODY}\n\nafter\n`;

/** The template architecture.json with its `__TOKENS__` filled in, as a plain contract object. */
export function templateContract(over: { packageManager?: string } = {}) {
  const raw = readFileSync(
    new URL("../../templates/root/architecture.json", import.meta.url),
    "utf8",
  )
    .replace("__SCOPE__", "@acme")
    .replace("__PM__", over.packageManager ?? "pnpm")
    .replace("__CLAUDE_SHA__", claudeBlockHash(CLAUDE_MD) ?? "");
  return contractFrom(JSON.parse(raw));
}
