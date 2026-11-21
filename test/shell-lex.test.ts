import { describe, expect, it } from "vitest";
import { splitArgs, targetsOf } from "../templates/root/scripts/shell-lex.mjs";

const words = (cmd: string) =>
  targetsOf(cmd, "/proj").segments.map((s) => s.words.map((w: { text: string }) => w.text));

describe("shell lexer", () => {
  it("splits on operators and removes quotes", () => {
    expect(words(`echo 'a b' "c d" && rm -rf x | cat; ls`)).toEqual([
      ["echo", "a b", "c d"],
      ["rm", "-rf", "x"],
      ["cat"],
      ["ls"],
    ]);
  });

  it("decodes ANSI-C quoting and drops comments", () => {
    expect(words("echo $'\\x72m' # rm -rf /")).toEqual([["echo", "rm"]]);
  });

  it("collects redirects apart from the words", () => {
    const r = targetsOf("echo hi > out.txt 2>&1", "/proj");
    expect(r.redirects.map((x) => [x.op, x.target])).toEqual([[">", "out.txt"]]);
    expect(r.segments[0].words.map((w: { text: string }) => w.text)).toEqual(["echo", "hi"]);
  });

  it("keeps heredoc bodies out of the command list", () => {
    const r = targetsOf("cat <<EOF\nrm -rf x\nEOF\nls", "/proj");
    expect(r.commands.map((c) => c.name)).toEqual(["cat", "ls"]);
    expect(r.segments[0].bodies).toEqual(["rm -rf x\n"]);
  });

  it("tracks cd into the directories a command may run in", () => {
    const r = targetsOf("cd sub && rm x", "/proj");
    expect(r.commands.find((c) => c.name === "rm")?.tight).toEqual(["/proj/sub"]);
  });

  it("returns nested command strings of substitutions", () => {
    expect(targetsOf('echo "$(rm x)"', "/proj").nested).toEqual(["rm x"]);
  });

  it("splits flags from operands", () => {
    const a = (t: string) => ({ text: t, quoted: false });
    expect(splitArgs([a("-rf"), a("x"), a("--"), a("-y")])).toMatchObject({
      flags: ["-rf"],
      operands: [{ text: "x" }, { text: "-y" }],
    });
  });
});
