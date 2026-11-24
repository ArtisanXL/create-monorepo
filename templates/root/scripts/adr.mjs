#!/usr/bin/env node
/**
 * Review the ADR drafts agents and developers leave in docs/adr/proposed/ (see docs/adr/0002-deferred-packages.md).
 *   __RUN__ adr:list    list the drafts (read-only)
 *   __RUN__ adr:review  go through the drafts: accept, reject (with a reason), skip. Humans only: needs a terminal.
 * Accepting moves the draft to docs/adr/ under the next number and prints its `architecture.json change`
 * for you to apply by hand; architecture.json is never edited by this script.
 */
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { acceptDraft, listDrafts, PROPOSED_DIR, readDraft, rejectDraft, summaryOf } from "./adr-lib.mjs";

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
          const { file, change } = acceptDraft(root, name, today());
          console.log(`Accepted: ${file}`);
          if (change) console.log(`\nApply this to architecture.json by hand:\n\n${change}\n`);
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
