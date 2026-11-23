import { describe, expect, it } from "vitest";
import { checkBlocks, hasDirectiveLines, resolveBlocks } from "../src/blocks.ts";
import { contextOf, FULL_CONTEXT } from "../src/components.ts";

const web = contextOf({ apps: ["web"], packages: [] });

describe("resolveBlocks", () => {
  it("returns text without directives untouched", () => {
    expect(resolveBlocks("a\n  b\n", web)).toBe("a\n  b\n");
  });

  it("keeps a block when its component is in the Closure and drops it otherwise", () => {
    const text = "x\n@if api\nA\n@endif\n@if web\nW\n@endif\ny\n";
    expect(resolveBlocks(text, FULL_CONTEXT)).toBe("x\nA\nW\ny\n");
    expect(resolveBlocks(text, web)).toBe("x\nW\ny\n");
  });

  it("supports negation, all-of terms, @else and nesting", () => {
    const text =
      "@if !api\nN\n@endif\n@if api web\nAW\n@else\nnot-both\n@endif\n@if web\n@if db\nD\n@endif\n@endif\n";
    expect(resolveBlocks(text, web)).toBe("N\nnot-both\n");
    expect(resolveBlocks(text, FULL_CONTEXT)).toBe("AW\nD\n");
  });

  it("allows indented directives and removes the whole line", () => {
    expect(resolveBlocks("a\n  @if web\n  b\n  @endif\n", web)).toBe("a\n  b\n");
  });

  it("drops a comma left dangling in JSON, and only in JSON", () => {
    const text = '{\n  "a": 1,\n@if db\n  "b": 2\n@endif\n}\n';
    expect(JSON.parse(resolveBlocks(text, web, "x.json"))).toEqual({ a: 1 });
    expect(resolveBlocks(text, web, "x.md")).toContain('"a": 1,\n}');
  });

  it("never rewrites string values when dropping a dangling comma", () => {
    const text =
      '{\n  "a": "x,}",\n  "b": ["y, ]",\n@if db\n    "c"\n@endif\n  ],\n@if db\n  "d": 1\n@endif\n}\n';
    const out = resolveBlocks(text, web, "x.json");
    expect(out).toContain('"a": "x,}",');
    expect(out).toContain('"y, ]"');
    expect(JSON.parse(out)).toEqual({ a: "x,}", b: ["y, ]"] });
    // Nothing is dropped, nothing is touched.
    expect(JSON.parse(resolveBlocks(text, FULL_CONTEXT, "x.json"))).toMatchObject({ d: 1 });
  });

  it("supports alternatives with | and negated alternatives", () => {
    const text = "@if api|worker\nany\n@endif\n@if !api|worker\nnone\n@endif\n";
    expect(resolveBlocks(text, web)).toBe("none\n");
    expect(resolveBlocks(text, contextOf({ apps: ["worker"], packages: [] }))).toBe("any\n");
  });

  it("recognises CRLF directive lines", () => {
    expect(hasDirectiveLines("a\r\n@endif\r\n")).toBe(true);
    expect(checkBlocks("@if web\r\nx\r\n")).toHaveLength(1);
    expect(resolveBlocks("@if web\r\nx\r\n@endif\r\n", web)).toBe("x\r\n");
  });

  it("rejects unbalanced blocks and unknown component names", () => {
    expect(() => resolveBlocks("@if web\nx\n", web, "f")).toThrow(/f:1: @if is never closed/);
    expect(() => resolveBlocks("x\n@endif\n", web, "f")).toThrow(/f:2: @endif without/);
    expect(() => resolveBlocks("@if nope\n@endif\n", web, "f")).toThrow(/unknown component 'nope'/);
    expect(() => resolveBlocks("@if web\n@else\n@else\n@endif\n", web, "f")).toThrow(/twice/);
  });
});

describe("checkBlocks / hasDirectiveLines", () => {
  it("reports every problem with its line", () => {
    expect(checkBlocks("@if web\n@endif\n")).toEqual([]);
    expect(checkBlocks("@if\n@endif x\n").map((e) => e.line)).toEqual([1, 2]);
  });

  it("detects leftover directive lines", () => {
    expect(hasDirectiveLines("a\n  @endif\n")).toBe(true);
    expect(hasDirectiveLines("an @if inside prose\n")).toBe(false);
  });
});
