import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: "esm",
  platform: "node",
  target: "node24",
  clean: true,
  banner: "#!/usr/bin/env node",
});
