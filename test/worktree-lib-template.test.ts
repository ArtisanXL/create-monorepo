import { describe, expect, it } from "vitest";

// Imported by path so the template itself (what users receive) is what is tested.
const libPath = "../templates/root/scripts/worktree-lib.mjs";
const lib = (await import(libPath)) as {
  setLine: (text: string, key: string, value: string) => string;
};

describe("template worktree-lib setLine", () => {
  it("writes replacement-pattern characters in a value literally", () => {
    const value = "postgres://u:p$&x$'y$`z$1@localhost/db";
    expect(lib.setLine("DATABASE_URL=old\nOTHER=1\n", "DATABASE_URL", value)).toBe(
      `DATABASE_URL=${value}\nOTHER=1\n`,
    );
  });
});
