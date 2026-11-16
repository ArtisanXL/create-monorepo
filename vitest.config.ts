import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "templates/root/scripts/*.test.mjs"],
    testTimeout: 30_000,
  },
});
