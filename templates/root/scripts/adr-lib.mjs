// Pure ADR draft handling for scripts/adr.mjs: no prompts, no process state.
// Drafts live in docs/adr/proposed/; accepting moves one to docs/adr/ under the next number,
// rejecting moves it to docs/adr/rejected/ with the reason. architecture.json is never touched.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ADR_DIR = "docs/adr";
export const PROPOSED_DIR = "docs/adr/proposed";
export const REJECTED_DIR = "docs/adr/rejected";

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

/** The body of the draft's `## architecture.json change` section, or undefined when it holds no JSON. */
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

/** Moves the draft to docs/adr/ under the next number. Returns the new file name and the architecture.json change. */
export function acceptDraft(root, name, date) {
  const text = readDraft(root, name);
  const existing = readdirSync(join(root, ADR_DIR));
  const number = nextNumber(existing);
  const target = `${number}-${slugOf(name)}`;
  writeFileSync(join(root, ADR_DIR, target), acceptedText(text, number, date));
  rmSync(join(root, PROPOSED_DIR, name));
  return { file: `${ADR_DIR}/${target}`, change: architectureChange(text) };
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
