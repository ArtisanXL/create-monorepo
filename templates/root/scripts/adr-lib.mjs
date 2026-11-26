// Pure ADR draft handling for scripts/adr.mjs: no prompts, no process state.
// Drafts live in docs/adr/proposed/; accepting moves one to docs/adr/ under the next number,
// rejecting moves it to docs/adr/rejected/ with the reason. Accepting also applies the draft's
// architecture patch (a JSON Patch, RFC 6902) to architecture.json, all or nothing.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";

export const ADR_DIR = "docs/adr";
export const PROPOSED_DIR = "docs/adr/proposed";
export const REJECTED_DIR = "docs/adr/rejected";
const ARCHITECTURE_FILE = "architecture.json";

const NUMBERED = /^(\d{4})-/;
const DRAFT_PREFIX = /^(?:\d{4}|NNNN)-/;

/** The next free ADR number as four digits: the highest numbered file in docs/adr/, plus one. */
export function nextNumber(names) {
  const highest = names.reduce((max, n) => Math.max(max, Number(NUMBERED.exec(n)?.[1] ?? 0)), 0);
  return String(highest + 1).padStart(4, "0");
}

/** The file name of a draft without its `NNNN-` / `0000-` number prefix. */
export const slugOf = (name) => name.replace(DRAFT_PREFIX, "");

const HEADING = /^#\s*(?:\d{4}|NNNN)\.\s*/m;
const STATUS = /^(- )?Status:.*$/m;
const DATE = /^(- )?Date:.*$/m;

function withStatus(text, status, date) {
  let out = STATUS.test(text) ? text.replace(STATUS, (_, dash = "") => `${dash}Status: ${status}`) : text;
  const dated = (_, dash = "") => `${dash}Date: ${date}`;
  if (DATE.test(out)) out = out.replace(DATE, dated);
  else out = out.replace(STATUS, (line, dash = "") => `${line}\n${dated(line, dash)}`);
  return out;
}

/** The text of an accepted ADR: numbered heading, `Status: accepted`, today's date. */
export function acceptedText(text, number, date) {
  return withStatus(text, "accepted", date).replace(HEADING, `# ${number}. `);
}

/** The text of a rejected draft: unnumbered heading, `Status: rejected (date): reason`, same date line. */
export function rejectedText(text, date, reason) {
  return withStatus(text, `rejected (${date}): ${reason.replace(/\s+/g, " ").trim()}`, date).replace(HEADING, "# ");
}

/** The body of the draft's `## architecture.json change` section (the architecture patch), or undefined when it holds no JSON. */
export function architectureChange(text) {
  const m = /^## architecture\.json change[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text);
  const body = m?.[1].replace(/```(?:json)?/g, "").trim();
  return body ? body : undefined;
}

/** The first heading line and the Status line of a draft, for the listing. */
export function summaryOf(text) {
  const title = /^#\s*(.+)$/m.exec(text)?.[1] ?? "(untitled)";
  const status = /^(?:- )?Status:\s*(.*)$/m.exec(text)?.[1] ?? "(no status)";
  return { title, status };
}

export function listDrafts(root) {
  const dir = join(root, PROPOSED_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".md") && n.toLowerCase() !== "readme.md")
    .sort();
}

export function readDraft(root, name) {
  return readFileSync(join(root, PROPOSED_DIR, name), "utf8");
}

export const ADR_PLACEHOLDER = "{{adr}}";
const OPS = new Set(["add", "remove", "replace", "test"]);

function pointerParts(pointer) {
  if (typeof pointer !== "string" || (pointer !== "" && !pointer.startsWith("/"))) throw new Error(`invalid JSON pointer ${JSON.stringify(pointer)}`);
  return pointer === "" ? [] : pointer.slice(1).split("/").map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function locate(doc, parts, op) {
  let parent = doc;
  for (const key of parts.slice(0, -1)) {
    parent = Array.isArray(parent) ? parent[Number(key)] : parent?.[key];
    if (parent === null || typeof parent !== "object") throw new Error(`${op.op} ${op.path}: path does not exist`);
  }
  return parent;
}

function index(parent, key, op, { append }) {
  if (key === "-" && append) return parent.length;
  const i = /^(0|[1-9]\d*)$/.test(key) ? Number(key) : -1;
  if (i < 0 || i > parent.length - (append ? 0 : 1)) throw new Error(`${op.op} ${op.path}: array index out of range`);
  return i;
}

/** Applies an architecture patch (RFC 6902 `add`/`remove`/`replace`/`test`) to a copy of `doc`. Throws on any failure. */
export function applyPatch(doc, ops) {
  if (!Array.isArray(ops)) throw new Error("the architecture patch must be a JSON array of operations");
  let out = structuredClone(doc);
  for (const op of ops) {
    if (op === null || typeof op !== "object" || !OPS.has(op.op)) throw new Error(`unsupported patch operation ${JSON.stringify(op)}`);
    const parts = pointerParts(op.path);
    const hasValue = Object.hasOwn(op, "value");
    if (op.op !== "remove" && !hasValue) throw new Error(`${op.op} ${op.path}: "value" is required`);
    if (parts.length === 0) {
      if (op.op === "test") {
        if (!isDeepStrictEqual(out, op.value)) throw new Error(`test ${op.path}: value does not match`);
      } else if (op.op === "remove") throw new Error("remove: the document root cannot be removed");
      else out = structuredClone(op.value);
      continue;
    }
    const parent = locate(out, parts, op);
    const key = parts.at(-1);
    if (Array.isArray(parent)) {
      const i = index(parent, key, op, { append: op.op === "add" });
      if (op.op === "add") parent.splice(i, 0, structuredClone(op.value));
      else if (op.op === "remove") parent.splice(i, 1);
      else if (op.op === "replace") parent[i] = structuredClone(op.value);
      else if (!isDeepStrictEqual(parent[i], op.value)) throw new Error(`test ${op.path}: value does not match`);
    } else {
      const exists = Object.hasOwn(parent, key);
      if (op.op === "add") parent[key] = structuredClone(op.value);
      else if (!exists) throw new Error(`${op.op} ${op.path}: path does not exist`);
      else if (op.op === "remove") delete parent[key];
      else if (op.op === "replace") parent[key] = structuredClone(op.value);
      else if (!isDeepStrictEqual(parent[key], op.value)) throw new Error(`test ${op.path}: value does not match`);
    }
  }
  return out;
}

/** Throws unless the patched architecture.json still has the shape the contract readers expect. */
export function assertContract(json) {
  const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  if (!isObject(json)) throw new Error("architecture.json must stay a JSON object");
  if (json.packages !== undefined && !isObject(json.packages)) throw new Error('"packages" must be an object');
  if (json.deferred !== undefined && !Array.isArray(json.deferred)) throw new Error('"deferred" must be an array');
  for (const [dir, pkg] of Object.entries(json.packages ?? {})) {
    if (!isObject(pkg)) throw new Error(`packages/${dir}: must be an object`);
    if (typeof pkg.adr === "string" && pkg.adr.startsWith(`${PROPOSED_DIR}/`)) throw new Error(`${dir}: "adr" may not point into ${PROPOSED_DIR}/`);
  }
}

/** The parsed patch of a draft: undefined when it has none, a thrown error when it is not a JSON array. `{{adr}}` becomes `adrPath`. */
export function patchOf(text, adrPath) {
  const change = architectureChange(text);
  if (change === undefined) return undefined;
  let ops;
  try {
    ops = JSON.parse(change.split(ADR_PLACEHOLDER).join(adrPath));
  } catch (e) {
    throw new Error(`the architecture.json change is not valid JSON: ${e.message}`);
  }
  if (!Array.isArray(ops)) throw new Error("the architecture.json change must be a JSON Patch array");
  return ops.length === 0 ? undefined : ops;
}

/**
 * Validates everything accepting a draft would do, and writes nothing. `after` is undefined when the
 * draft has no patch. Throws when the patch is invalid, a `test` fails, or the result breaks the contract shape.
 */
export function prepareAccept(root, name, date) {
  const text = readDraft(root, name);
  const number = nextNumber(readdirSync(join(root, ADR_DIR)));
  const file = `${ADR_DIR}/${number}-${slugOf(name)}`;
  const ops = patchOf(text, file);
  let before;
  let after;
  if (ops) {
    before = JSON.parse(readFileSync(join(root, ARCHITECTURE_FILE), "utf8"));
    after = applyPatch(before, ops);
    assertContract(after);
  }
  return { name, file, adrText: acceptedText(text, number, date), before, after };
}

/** Writes a prepared accept: architecture.json first, then the ADR, then the draft is removed. */
export function commitAccept(root, plan) {
  if (plan.after) writeFileSync(join(root, ARCHITECTURE_FILE), `${JSON.stringify(plan.after, null, 2)}\n`);
  writeFileSync(join(root, plan.file), plan.adrText);
  rmSync(join(root, PROPOSED_DIR, plan.name));
  return { file: plan.file };
}

/** The lines of `before` and `after` as a unified-style listing: `- ` removed, `+ ` added, no marker for context omitted. */
export function diffLines(before, after) {
  const a = JSON.stringify(before, null, 2).split("\n");
  const b = JSON.stringify(after, null, 2).split("\n");
  const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push(`- ${a[i++]}`);
    else out.push(`+ ${b[j++]}`);
  }
  while (i < a.length) out.push(`- ${a[i++]}`);
  while (j < b.length) out.push(`+ ${b[j++]}`);
  return out.join("\n");
}

/** Moves the draft to docs/adr/rejected/ without a number. The reason is required. */
export function rejectDraft(root, name, date, reason) {
  if (!reason.trim()) throw new Error("A reason is required to reject a draft.");
  const text = readDraft(root, name);
  const dir = join(root, REJECTED_DIR);
  const target = slugOf(name);
  if (existsSync(join(dir, target))) throw new Error(`${REJECTED_DIR}/${target} already exists; rename the draft first.`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, target), rejectedText(text, date, reason));
  rmSync(join(root, PROPOSED_DIR, name));
  return { file: `${REJECTED_DIR}/${target}` };
}
