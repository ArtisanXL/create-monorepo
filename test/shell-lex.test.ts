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

  it("substitutes variables assigned earlier in the line and treats $IFS as whitespace", () => {
    expect(words("X=rm; Y=a.json; $X $Y")).toEqual([["X=rm"], ["Y=a.json"], ["rm", "a.json"]]);
    expect(words("echo $UNSET; rm$" + "{IFS}x")).toEqual([
      ["echo", "$UNSET"],
      ["rm", "x"],
    ]);
    expect(targetsOf("X=1", "/proj").vars.get("X")).toBe("1");
  });

  it("ends $IFS at a quote and treats it as a space", () => {
    expect(words("rm$IFS'a' x")).toEqual([["rm", "a", "x"]]);
  });

  it("brace-expands unquoted words only, and caps the result", () => {
    expect(words("echo {r,}m '{a,b}' $Y {a,b}{c,d}")).toEqual([
      ["echo", "rm", "m", "{a,b}", "$Y", "ac", "ad", "bc", "bd"],
    ]);
    expect(targetsOf(`echo ${"{a,b}".repeat(8)}`, "/proj").tooComplex).toBe(true);
  });

  it("gives a loop variable every value of its list, and keeps the values of a conditional assignment", () => {
    expect(words("for X in a b; do rm $X; done")[1]).toEqual(["do", "rm", "a", "b"]);
    expect(words("[ -n $Z ] && X=a || X=b; rm $X")[3]).toEqual(["rm", "a", "b"]);
    expect(words("X=a; X=b; rm $X")[2]).toEqual(["rm", "b"]);
  });

  it("reads a pattern group after the command name as part of the word", () => {
    const r = targetsOf("rm -rf d@(ocs) (a|b)x && (cd s; ls)", "/proj").segments;
    expect(r[0].words.map((w: { text: string }) => w.text)).toEqual(["rm", "-rf", "d*", "*x"]);
    expect(r[0].words.slice(2).every((w: { glob?: boolean }) => w.glob)).toBe(true);
    // a command-position `(` is still a subshell
    expect(r.slice(1).map((s) => s.words.map((w: { text: string }) => w.text))).toEqual([
      ["cd", "s"],
      ["ls"],
    ]);
  });
});
