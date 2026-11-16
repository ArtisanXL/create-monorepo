import type { AppType } from "__SCOPE__/api";
import { hc } from "hono/client";

/** Single entry point to the API. Endpoints and types are inferred from the Hono app. */
export const api = hc<AppType>("/").api;
