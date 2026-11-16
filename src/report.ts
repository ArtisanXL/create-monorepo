import type { Result } from "./scaffold.ts";

/** Renders scaffold's returned data for the terminal. */
export function formatResult(result: Result, target: string): string {
  return [
    ...result.written.map((f) => `  + ${f}`),
    ...result.skipped.map((f) => `  = ${f} (exists, skipped)`),
    "",
    `Scaffold ready: ${target}  (${result.written.length} new files)`,
  ].join("\n");
}
