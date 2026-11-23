@if cloudflare
import { cloudflare } from "@cloudflare/vite-plugin";
@endif
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

@if cloudflare
// Without an explicit port the plugin probes for one starting at 9229, as `wrangler dev` does, and
// loses the race against Workers started at the same moment. scripts/cloudflare-dev.mjs sets this
// per dev server; the fallback keeps a plain `vite` run on a port of its own.
const inspectorPort = Number(process.env.CLOUDFLARE_INSPECTOR_PORT) || 9232;

@endif
export default defineConfig({
@if cloudflare
  // Assets only, so there is no binding state to keep. Persisting it would also leave empty
  // `.wrangler/state` folders behind whenever vitest loads this config, which the arch check rejects.
@if api
  // `/api/*` reaches the separately running api `wrangler dev` over the service binding, through the
  // dev registry (CLOUDFLARE_DEV_REGISTRY_PATH, set per worktree by scripts/cloudflare-dev.mjs).
@endif
  plugins: [react(), cloudflare({ persistState: false, inspectorPort })],
@endif
@if node
  plugins: [react()],
@endif
@if node api
  // API_URL is set per worktree by paseo.json; defaults to the local API.
  server: { proxy: { "/api": process.env.API_URL ?? "http://localhost:3000" } },
@endif
});
