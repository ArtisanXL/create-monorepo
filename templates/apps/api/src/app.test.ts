import type { Db } from "__SCOPE__/db";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";

const downDb = {
  execute: () => Promise.reject(new Error("no connection")),
} as unknown as Db;

describe("api", () => {
  const app = createApp({ db: downDb });

  it("reports degraded when the DB is unreachable", async () => {
    const res = await app.request("/api/health");
    expect(await res.json()).toEqual({ status: "degraded", db: "down" });
  });

  it("formats a price", async () => {
    const res = await app.request("/api/format-price", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: "123456", currency: "USD", locale: "en-US" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ formatted: "$1,234.56" });
  });

  it("rejects invalid input via the contracts schema", async () => {
    const res = await app.request("/api/format-price", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: "12.5", currency: "USD" }),
    });
    expect(res.status).toBe(400);
  });

  it("answers 400, not 500, for a malformed currency or locale", async () => {
    for (const body of [
      { amount: "1", currency: "US1" },
      { amount: "1", currency: "USD", locale: "not a locale" },
    ]) {
      const res = await app.request("/api/format-price", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });
});
