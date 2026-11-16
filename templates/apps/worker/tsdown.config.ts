import { defineConfig } from "tsdown";

// Workspace packages are consumed as source, so they are bundled into the output.
export default defineConfig({
  entry: ["src/worker.ts"],
  platform: "node",
  format: "esm",
  outDir: "dist",
  noExternal: [/^__SCOPE_RE__\//],
});
