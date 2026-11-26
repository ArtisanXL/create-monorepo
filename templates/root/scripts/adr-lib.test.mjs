import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acceptedText,
  applyPatch,
  architectureChange,
  assertContract,
  commitAccept,
  diffLines,
  listDrafts,
  nextNumber,
  patchOf,
  prepareAccept,
  rejectDraft,
  rejectedText,
  slugOf,
} from "./adr-lib.mjs";

const DRAFT = `# NNNN. Use Redis

- Status: proposed | accepted | superseded by NNNN
- Date: YYYY-MM-DD

## Context
Slow.
## Decision
Add it.
## architecture.json change
\`\`\`json
[{ "op": "add", "path": "/packages/packages~1redis", "value": { "adr": "{{adr}}", "role": "Cache." } }]
\`\`\`
`;

const ARCH = `${JSON.stringify({ scope: "@x", packages: {}, deferred: [{ name: "redis", path: "packages/redis", deps: ["ioredis"] }] }, null, 2)}\n`;

describe("numbering", () => {
  it("is one past the highest numbered file", () => {
    expect(nextNumber(["0001-a.md", "0003-b.md", "0003-c.md", "TEMPLATE.md", "proposed"])).toBe("0004");
  });
  it("starts at 0001", () => {
    expect(nextNumber(["TEMPLATE.md"])).toBe("0001");
  });
  it("drops a number prefix from a draft name", () => {
    expect(slugOf("NNNN-use-redis.md")).toBe("use-redis.md");
    expect(slugOf("0000-use-redis.md")).toBe("use-redis.md");
    expect(slugOf("use-redis.md")).toBe("use-redis.md");
  });
});

describe("text rewriting", () => {
  it("accepts with number, status and date", () => {
    const out = acceptedText(DRAFT, "0006", "2026-01-02");
    expect(out).toContain("# 0006. Use Redis");
    expect(out).toContain("- Status: accepted\n- Date: 2026-01-02");
  });
  it("adds a date line when the draft has none", () => {
    const out = acceptedText("# NNNN. X\n\nStatus: proposed\n", "0002", "2026-01-02");
    expect(out).toContain("Status: accepted\nDate: 2026-01-02");
  });
  it("rejects with an unnumbered heading and the reason", () => {
    const out = rejectedText(DRAFT, "2026-01-02", "not   needed\nyet");
    expect(out).toContain("# Use Redis");
    expect(out).toContain("- Status: rejected (2026-01-02): not needed yet");
  });
  it("extracts the architecture.json change, if any", () => {
    expect(architectureChange(DRAFT)).toContain('"op": "add"');
    expect(architectureChange("# x\n\n## architecture.json change\n```json\n```\n")).toBeUndefined();
    expect(architectureChange("# x\n")).toBeUndefined();
  });
});

describe("moving drafts", () => {
  let root;
  const setup = () => {
    root = mkdtempSync(join(tmpdir(), "adr-lib-"));
    mkdirSync(join(root, "docs/adr/proposed"), { recursive: true });
    writeFileSync(join(root, "docs/adr/0001-a.md"), "# 0001. A\n");
    writeFileSync(join(root, "docs/adr/0002-b.md"), "# 0002. B\n");
    writeFileSync(join(root, "docs/adr/proposed/README.md"), "drafts\n");
    writeFileSync(join(root, "docs/adr/proposed/NNNN-use-redis.md"), DRAFT);
    writeFileSync(join(root, "architecture.json"), ARCH);
  };
  afterEach(() => root && rmSync(root, { recursive: true, force: true }));

  it("lists drafts without the README", () => {
    setup();
    expect(listDrafts(root)).toEqual(["NNNN-use-redis.md"]);
  });

  it("accepts a draft: patches architecture.json, numbers the ADR, fills {{adr}}", () => {
    setup();
    const plan = prepareAccept(root, "NNNN-use-redis.md", "2026-01-02");
    expect(plan.file).toBe("docs/adr/0003-use-redis.md");
    expect(plan.after.packages["packages/redis"]).toEqual({ adr: "docs/adr/0003-use-redis.md", role: "Cache." });
    expect(readFileSync(join(root, "architecture.json"), "utf8")).toBe(ARCH);
    expect(commitAccept(root, plan).file).toBe("docs/adr/0003-use-redis.md");
    expect(readFileSync(join(root, plan.file), "utf8")).toContain("# 0003. Use Redis");
    expect(JSON.parse(readFileSync(join(root, "architecture.json"), "utf8")).packages["packages/redis"].adr).toBe(plan.file);
    expect(listDrafts(root)).toEqual([]);
  });

  it("accepts a draft with no patch without touching architecture.json", () => {
    setup();
    writeFileSync(join(root, "docs/adr/proposed/NNNN-use-redis.md"), "# NNNN. X\n\nStatus: proposed\n\n## architecture.json change\n```json\n```\n");
    const plan = prepareAccept(root, "NNNN-use-redis.md", "2026-01-02");
    expect(plan.after).toBeUndefined();
    commitAccept(root, plan);
    expect(readFileSync(join(root, "architecture.json"), "utf8")).toBe(ARCH);
  });

  it("changes nothing when the patch is invalid, a test fails, or the result breaks the contract", () => {
    setup();
    const bad = (body) => {
      writeFileSync(join(root, "docs/adr/proposed/NNNN-use-redis.md"), `# NNNN. X\n\nStatus: proposed\n\n## architecture.json change\n\`\`\`json\n${body}\n\`\`\`\n`);
      expect(() => prepareAccept(root, "NNNN-use-redis.md", "2026-01-02")).toThrow();
    };
    bad("free-form prose");
    bad('{ "deferred": [] }');
    bad('[{ "op": "test", "path": "/scope", "value": "@other" }]');
    bad('[{ "op": "replace", "path": "/packages", "value": [] }]');
    bad('[{ "op": "add", "path": "/packages/x", "value": { "adr": "docs/adr/proposed/x.md" } }]');
    expect(readFileSync(join(root, "architecture.json"), "utf8")).toBe(ARCH);
    expect(listDrafts(root)).toEqual(["NNNN-use-redis.md"]);
  });

  it("rejects a draft into docs/adr/rejected/ and requires a reason", () => {
    setup();
    expect(() => rejectDraft(root, "NNNN-use-redis.md", "2026-01-02", "  ")).toThrow(/reason/);
    const { file } = rejectDraft(root, "NNNN-use-redis.md", "2026-01-02", "no trigger");
    expect(file).toBe("docs/adr/rejected/use-redis.md");
    expect(readFileSync(join(root, file), "utf8")).toContain("rejected (2026-01-02): no trigger");
    expect(readdirSync(join(root, "docs/adr"))).not.toContain("0003-use-redis.md");
  });

  it("refuses to overwrite an earlier rejection", () => {
    setup();
    rejectDraft(root, "NNNN-use-redis.md", "2026-01-02", "no");
    writeFileSync(join(root, "docs/adr/proposed/NNNN-use-redis.md"), DRAFT);
    expect(() => rejectDraft(root, "NNNN-use-redis.md", "2026-01-03", "still no")).toThrow(/already exists/);
  });
});

describe("applyPatch", () => {
  const doc = { a: { list: [1, 2, 3] }, deferred: [{ name: "x" }] };
  it("adds, appends, inserts, replaces and removes", () => {
    const out = applyPatch(doc, [
      { op: "add", path: "/a/list/-", value: 4 },
      { op: "add", path: "/a/list/0", value: 0 },
      { op: "replace", path: "/a/list/1", value: 9 },
      { op: "remove", path: "/deferred/0" },
      { op: "add", path: "/b", value: true },
    ]);
    expect(out).toEqual({ a: { list: [0, 9, 2, 3, 4] }, deferred: [], b: true });
    expect(doc.a.list).toEqual([1, 2, 3]);
  });
  it("unescapes ~0 and ~1 in pointers", () => {
    expect(applyPatch({}, [{ op: "add", path: "/a~1b~0c", value: 1 }])).toEqual({ "a/b~c": 1 });
  });
  it("test guards stale documents", () => {
    expect(() => applyPatch(doc, [{ op: "test", path: "/deferred/0/name", value: "y" }])).toThrow(/does not match/);
    expect(applyPatch(doc, [{ op: "test", path: "/deferred/0/name", value: "x" }])).toEqual(doc);
  });
  it("rejects bad operations and missing paths", () => {
    expect(() => applyPatch(doc, [{ op: "move", path: "/a", from: "/b" }])).toThrow(/unsupported/);
    expect(() => applyPatch(doc, [{ op: "remove", path: "/nope" }])).toThrow(/does not exist/);
    expect(() => applyPatch(doc, [{ op: "replace", path: "/a/list/7", value: 1 }])).toThrow(/out of range/);
    expect(() => applyPatch(doc, [{ op: "add", path: "/x/y", value: 1 }])).toThrow(/does not exist/);
    expect(() => applyPatch(doc, [{ op: "add", path: "/x" }])).toThrow(/value/);
  });
});

describe("contract and diff", () => {
  it("rejects a result that is not a contract-shaped object", () => {
    expect(() => assertContract([])).toThrow();
    expect(() => assertContract({ deferred: {} })).toThrow(/deferred/);
    expect(() => assertContract({ packages: { p: { adr: "docs/adr/proposed/a.md" } } })).toThrow(/proposed/);
    expect(() => assertContract({ packages: { p: { adr: "docs/adr/0001-a.md" } } })).not.toThrow();
  });
  it("shows removed and added lines", () => {
    const out = diffLines({ a: 1, b: 2 }, { a: 1, b: 3 });
    expect(out).toBe('-   "b": 2\n+   "b": 3');
  });
  it("patchOf treats an empty array as no change", () => {
    expect(patchOf("## architecture.json change\n```json\n[]\n```\n", "x")).toBeUndefined();
  });
});
