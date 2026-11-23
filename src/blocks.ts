import {
  COMPONENT_NAMES,
  type ComponentName,
  isComponentName,
  isRuntime,
  type ResolutionContext,
  RUNTIMES,
  type Runtime,
} from "./components.ts";

/**
 * Line-based conditional blocks in templates:
 *
 *     @if api          kept when `api` is in the Closure
 *     @if !api         kept when `api` is not in the Closure
 *     @if api web      kept when every term holds (`@if api !web` is allowed too)
 *     @if cloudflare   kept when the Runtime is `cloudflare` (`node` likewise); Runtime terms
 *                      combine with Component terms, negation and alternatives
 *     @if api|web      a term may list alternatives: true when any of them is present
 *                      (`@if !api|web` is true when none is)
 *     @else            the opposite branch of the nearest open @if
 *     @endif
 *
 * A directive owns its whole line (leading whitespace allowed) and the line is removed. Blocks
 * nest. They are resolved before token substitution and work in every file type.
 */
const DIRECTIVE = /^[ \t]*@(if|else|endif)\b(.*)\r?$/;

export interface BlockError {
  line: number;
  message: string;
}

/** A term holds when any of `names` is in the Closure or is the Runtime (negated: when none is). */
interface Term {
  names: (ComponentName | Runtime)[];
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
    const terms: Term[] = [];
    for (const raw of arg.split(/\s+/).filter(Boolean)) {
      const negate = raw.startsWith("!");
      const names: Term["names"] = [];
      for (const name of (negate ? raw.slice(1) : raw).split("|")) {
        if (isComponentName(name) || isRuntime(name)) names.push(name);
        else {
          errors.push({
            line: n,
            message: `@if names unknown component '${name}' (known: ${COMPONENT_NAMES.join(", ")}; runtimes: ${RUNTIMES.join(", ")})`,
          });
        }
      }
      terms.push({ names, negate });
    }
    if (terms.length === 0)
      errors.push({ line: n, message: "@if needs a component or runtime name" });
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

const holds = (frame: Frame, { closure, runtime }: ResolutionContext): boolean => {
  const all = frame.terms.every(
    ({ names, negate }) =>
      names.some((n) => (isRuntime(n) ? n === runtime : closure.has(n))) !== negate,
  );
  return all !== frame.inElse;
};

/**
 * Resolves the blocks for `context`. In JSON files, when removed lines are followed by a line
 * that closes an object or array, the comma ending the last kept line before them is dropped, so
 * templates need no per-entry comma blocks. The fix-up is line-based and never reads string values.
 */
export function resolveBlocks(text: string, context: ResolutionContext, file = ""): string {
  if (!hasDirectiveLines(text)) return text;
  const { lines, errors } = parse(text);
  if (errors.length) {
    const first = errors[0] as BlockError;
    throw new Error(`${file || "template"}:${first.line}: ${first.message}`);
  }
  const json = file.endsWith(".json");
  const kept: string[] = [];
  let droppedSinceKept = false;
  for (const { text: line, frames } of lines) {
    if (!frames.every((f) => holds(f, context))) {
      droppedSinceKept = true;
      continue;
    }
    if (json && droppedSinceKept && /^\s*[}\]]/.test(line)) {
      const last = kept.length - 1;
      const prev = kept[last];
      if (prev !== undefined && /,\s*$/.test(prev)) kept[last] = prev.replace(/,(\s*)$/, "$1");
    }
    droppedSinceKept = false;
    kept.push(line);
  }
  return kept.join("\n");
}
