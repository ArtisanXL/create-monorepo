import { FormatPriceRequest } from "__SCOPE__/contracts";
import { checkHealth, formatPrice } from "__SCOPE__/core";
import type { Db } from "__SCOPE__/db";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";

export interface AppDeps {
  db: Db;
}

/** HTTP layer: validation + core calls only. No business rules here. */
export function createApp({ db }: AppDeps) {
  return new Hono()
    .basePath("/api")
    .get("/health", async (c) => c.json(await checkHealth(db)))
    .post("/format-price", zValidator("json", FormatPriceRequest), (c) =>
      c.json(formatPrice(c.req.valid("json"))),
    );
}

export type AppType = ReturnType<typeof createApp>;
