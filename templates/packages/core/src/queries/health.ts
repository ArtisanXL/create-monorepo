import type { HealthResponse } from "__SCOPE__/contracts";
import { type Db, ping } from "__SCOPE__/db";

export async function checkHealth(db: Db): Promise<HealthResponse> {
  try {
    await ping(db);
    return { status: "ok", db: "up" };
  } catch {
    return { status: "degraded", db: "down" };
  }
}
