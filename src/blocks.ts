import { type Closure, COMPONENT_NAMES, isComponentName } from "./components.ts";

/**
 * Line-based conditional blocks in templates:
 *
 *     @if api          kept when `api` is in the Closure
 *     @if !api         kept when `api` is not in the Closure
 *     @endif
 *
 * A directive owns its whole line (leading whitespace allowed) and the line is removed. Blocks
 * nest. They are resolved before token substitution and work in every file type.
 */
const DIRECTIVE = /^[ \t]*@(if|endif)\b(.*)$/;

export interface BlockError {
  line: number;
  message: string;
}

interface Parsed {
  /** Lines to keep, with the condition stack evaluated by `keep`. */
  lines: { text: string; conds: { name: string; negate: boolean }[] }[];
  errors: BlockError[];
}

function parse(text: string): Parsed {
  const lines: Parsed["lines"] = [];
  const errors: BlockError[] = [];
  const stack: { name: string; negate: boolean; line: number }[] = [];
  text.split("\n").forEach((raw, i) => {
    const n = i + 1;
    const m = DIRECTIVE.exec(raw);
    if (!m) {
      lines.push({ text: raw, conds: stack.map(({ name, negate }) => ({ name, negate })) });
      return;
    }
    const arg = (m[2] ?? "").trim();
    if (m[1] === "endif") {
      if (arg) errors.push({ line: n, message: `@endif takes no argument (got '${arg}')` });
      if (!stack.pop()) errors.push({ line: n, message: "@endif without a matching @if" });
      return;
    }
    const negate = arg.startsWith("!");
    const name = negate ? arg.slice(1) : arg;
    if (!isComponentName(name)) {
      errors.push({
        line: n,
        message: `@if names unknown component '${arg}' (known: ${COMPONENT_NAMES.join(", ")})`,
      });
    }
    stack.push({ name, negate, line: n });
  });
  for (const open of stack) errors.push({ line: open.line, message: "@if is never closed" });
  return { lines, errors };
}

/** Problems with the directives in `text`: unbalanced blocks, unknown component names. */
export const checkBlocks = (text: string): BlockError[] => parse(text).errors;

/** True when a line that looks like a directive survived; used to assert nothing is left over. */
export const hasDirectiveLines = (text: string): boolean =>
  text.split("\n").some((l) => DIRECTIVE.test(l));

/**
 * Resolves the blocks for `closure`. In JSON files, a comma left dangling by a removed final
 * entry is dropped, so templates need no per-entry comma blocks.
 */
export function resolveBlocks(text: string, closure: Closure, file = ""): string {
  if (!hasDirectiveLines(text)) return text;
  const { lines, errors } = parse(text);
  if (errors.length) {
    const first = errors[0] as BlockError;
    throw new Error(`${file || "template"}:${first.line}: ${first.message}`);
  }
  const kept = lines
    .filter(({ conds }) => conds.every(({ name, negate }) => closure.has(name as never) !== negate))
    .map((l) => l.text)
    .join("\n");
  return file.endsWith(".json") ? kept.replace(/,(\s*[}\]])/g, "$1") : kept;
}
