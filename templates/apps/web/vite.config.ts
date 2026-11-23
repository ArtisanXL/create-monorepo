@if cloudflare
import { cloudflare } from "@cloudflare/vite-plugin";
@endif
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
@if cloudflare
  // Assets only, so there is no binding state to keep. Persisting it would also leave empty
  // `.wrangler/state` folders behind whenever vitest loads this config, which the arch check rejects.
@if api
  // `/api/*` reaches the separately running api `wrangler dev` over the service binding, through the
  // dev registry (CLOUDFLARE_DEV_REGISTRY_PATH, set per worktree by scripts/cloudflare-dev.mjs).
@endif
  plugins: [react(), cloudflare({ persistState: false })],
@endif
@if node
  plugins: [react()],
@endif
@if node api
  // API_URL is set per worktree by paseo.json; defaults to the local API.
  server: { proxy: { "/api": process.env.API_URL ?? "http://localhost:3000" } },
@endif
});
