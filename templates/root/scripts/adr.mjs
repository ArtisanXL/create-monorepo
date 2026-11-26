#!/usr/bin/env node
/**
 * Review the ADR drafts agents and developers leave in docs/adr/proposed/ (see docs/adr/0002-deferred-packages.md).
 *   __RUN__ adr:list    list the drafts (read-only)
 *   __RUN__ adr:review  go through the drafts: accept, reject (with a reason), skip. Humans only: needs a terminal.
 * Accepting moves the draft to docs/adr/ under the next number and applies its `architecture.json change`
 * (a JSON Patch) to architecture.json, after showing the diff and asking for confirmation. All or nothing.
 */
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { commitAccept, diffLines, listDrafts, PROPOSED_DIR, prepareAccept, readDraft, rejectDraft, summaryOf } from "./adr-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const today = () => new Date().toISOString().slice(0, 10);

function list() {
  const drafts = listDrafts(root);
  if (drafts.length === 0) return console.log(`No drafts in ${PROPOSED_DIR}/.`);
  for (const name of drafts) {
    const { title, status } = summaryOf(readDraft(root, name));
    console.log(`${name}\n  ${title}\n  Status: ${status}`);
  }
}

async function review() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("adr:review is interactive and needs a terminal; only humans accept or reject drafts. Use adr:list to read them.");
    process.exit(1);
  }
  const drafts = listDrafts(root);
  if (drafts.length === 0) return console.log(`No drafts in ${PROPOSED_DIR}/.`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const [i, name] of drafts.entries()) {
      console.log(`\n=== ${i + 1}/${drafts.length}: ${name} ===\n\n${readDraft(root, name)}`);
      for (;;) {
        const answer = (await rl.question("[a]ccept / [r]eject / [s]kip / [q]uit? ")).trim().toLowerCase();
        if (answer === "q") return;
        if (answer === "s") break;
        if (answer === "a") {
          let plan;
          try {
            plan = prepareAccept(root, name, today());
          } catch (e) {
            console.log(`Cannot accept ${name}: ${e.message}\nNothing changed.`);
            break;
          }
          if (plan.after) {
            console.log(`\narchitecture.json change:\n\n${diffLines(plan.before, plan.after)}\n`);
            if ((await rl.question("Apply this and accept? [y/N] ")).trim().toLowerCase() !== "y") {
              console.log("Nothing changed.");
              break;
            }
          }
          console.log(`Accepted: ${commitAccept(root, plan).file}`);
          break;
        }
        if (answer === "r") {
          const reason = (await rl.question("Reason: ")).trim();
          if (!reason) {
            console.log("A reason is required; nothing changed.");
            continue;
          }
          console.log(`Rejected: ${rejectDraft(root, name, today(), reason).file}`);
          break;
        }
      }
    }
  } finally {
    rl.close();
  }
}

const command = process.argv[2];
if (command === "list") list();
else if (command === "review") await review();
else {
  console.error("Usage: node scripts/adr.mjs list | review");
  process.exit(1);
}
