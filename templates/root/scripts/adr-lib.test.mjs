import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acceptDraft,
  acceptedText,
  architectureChange,
  listDrafts,
  nextNumber,
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
{ "deferred": [] }
\`\`\`
`;

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
    expect(architectureChange(DRAFT)).toBe('{ "deferred": [] }');
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
  };
  afterEach(() => root && rmSync(root, { recursive: true, force: true }));

  it("lists drafts without the README", () => {
    setup();
    expect(listDrafts(root)).toEqual(["NNNN-use-redis.md"]);
  });

  it("accepts a draft under the next number", () => {
    setup();
    const { file, change } = acceptDraft(root, "NNNN-use-redis.md", "2026-01-02");
    expect(file).toBe("docs/adr/0003-use-redis.md");
    expect(change).toBe('{ "deferred": [] }');
    expect(readFileSync(join(root, file), "utf8")).toContain("# 0003. Use Redis");
    expect(listDrafts(root)).toEqual([]);
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
