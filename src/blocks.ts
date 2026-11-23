import { type Closure, COMPONENT_NAMES, isComponentName } from "./components.ts";

/**
 * Line-based conditional blocks in templates:
 *
 *     @if api          kept when `api` is in the Closure
 *     @if !api         kept when `api` is not in the Closure
 *     @if api web      kept when every term holds (`@if api !web` is allowed too)
 *     @else            the opposite branch of the nearest open @if
 *     @endif
 *
 * A directive owns its whole line (leading whitespace allowed) and the line is removed. Blocks
 * nest. They are resolved before token substitution and work in every file type.
 */
const DIRECTIVE = /^[ \t]*@(if|else|endif)\b(.*)$/;

export interface BlockError {
  line: number;
  message: string;
}

interface Term {
  name: string;
  negate: boolean;
}

interface Frame {
  terms: Term[];
  inElse: boolean;
  line: number;
}

interface Parsed {
  /** Each line with the frames that govern it. */
  lines: { text: string; frames: Frame[] }[];
  errors: BlockError[];
}

function parse(text: string): Parsed {
  const lines: Parsed["lines"] = [];
  const errors: BlockError[] = [];
  const stack: Frame[] = [];
  text.split("\n").forEach((raw, i) => {
    const n = i + 1;
    const m = DIRECTIVE.exec(raw);
    if (!m) {
      // Frames are copied so a later @else does not rewrite the lines already read.
      lines.push({ text: raw, frames: stack.map((f) => ({ ...f })) });
      return;
    }
    const arg = (m[2] ?? "").trim();
    if (m[1] === "endif") {
      if (arg) errors.push({ line: n, message: `@endif takes no argument (got '${arg}')` });
      if (!stack.pop()) errors.push({ line: n, message: "@endif without a matching @if" });
      return;
    }
    if (m[1] === "else") {
      const top = stack[stack.length - 1];
      if (arg) errors.push({ line: n, message: `@else takes no argument (got '${arg}')` });
      if (!top) errors.push({ line: n, message: "@else without a matching @if" });
      else if (top.inElse) errors.push({ line: n, message: "@else appears twice in one block" });
      else top.inElse = true;
      return;
    }
    const terms = arg
      .split(/\s+/)
      .filter(Boolean)
      .map(
        (t): Term =>
          t.startsWith("!") ? { name: t.slice(1), negate: true } : { name: t, negate: false },
      );
    if (terms.length === 0) errors.push({ line: n, message: "@if needs a component name" });
    for (const t of terms) {
      if (!isComponentName(t.name)) {
        errors.push({
          line: n,
          message: `@if names unknown component '${t.name}' (known: ${COMPONENT_NAMES.join(", ")})`,
        });
      }
    }
    stack.push({ terms, inElse: false, line: n });
  });
  for (const open of stack) errors.push({ line: open.line, message: "@if is never closed" });
  return { lines, errors };
}

/** Problems with the directives in `text`: unbalanced blocks, unknown component names. */
export const checkBlocks = (text: string): BlockError[] => parse(text).errors;

/** True when a directive line is present; used to assert nothing is left over after resolving. */
export const hasDirectiveLines = (text: string): boolean =>
  text.split("\n").some((l) => DIRECTIVE.test(l));

const holds = (frame: Frame, closure: Closure): boolean => {
  const all = frame.terms.every(({ name, negate }) => closure.has(name as never) !== negate);
  return all !== frame.inElse;
};

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
    .filter(({ frames }) => frames.every((f) => holds(f, closure)))
    .map((l) => l.text)
    .join("\n");
  return file.endsWith(".json") ? kept.replace(/,(\s*[}\]])/g, "$1") : kept;
}
