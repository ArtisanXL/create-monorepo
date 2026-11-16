import { expect, it } from "vitest";
import { formatResult } from "../src/report.ts";

it("ends with the adapter-provided next steps", () => {
  const out = formatResult({ written: ["a"], skipped: [] }, "/t", "Next steps:\n  zz dev");
  expect(out).toContain("Scaffold ready: /t  (1 new files)");
  expect(out.endsWith("\n\nNext steps:\n  zz dev")).toBe(true);
});
