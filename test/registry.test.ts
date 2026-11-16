import { describe, expect, it } from "vitest";
import { createRegistryResolver } from "../src/registry.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("registry version resolver", () => {
  it("returns the exact latest version from the registry", async () => {
    const urls: string[] = [];
    const resolve = createRegistryResolver(async (url) => {
      urls.push(String(url));
      return json({ name: "@biomejs/biome", version: "2.6.7" });
    });
    expect(await resolve("@biomejs/biome")).toBe("2.6.7");
    expect(urls).toEqual(["https://registry.npmjs.org/@biomejs/biome/latest"]);
  });

  it("fails naming the package on an HTTP error", async () => {
    const resolve = createRegistryResolver(async () => json({}, 404));
    await expect(resolve("nope")).rejects.toThrow(/nope/);
  });

  it("fails naming the package on a network error or missing version", async () => {
    const down = createRegistryResolver(async () => {
      throw new Error("offline");
    });
    await expect(down("zod")).rejects.toThrow(/zod/);
    const bad = createRegistryResolver(async () => json({ name: "zod" }));
    await expect(bad("zod")).rejects.toThrow(/zod/);
  });
});
