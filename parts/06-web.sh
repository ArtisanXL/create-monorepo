# --- apps/web ----------------------------------------------------------------------------
emit apps/web/package.json <<'EOF'
{
  "name": "__SCOPE__/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "typecheck": "tsc -p ."
  },
  "dependencies": {
    "__SCOPE__/contracts": "workspace:*",
    "__SCOPE__/domain": "workspace:*",
    "@tanstack/react-query": "catalog:",
    "hono": "catalog:",
    "react": "catalog:",
    "react-dom": "catalog:"
  },
  "devDependencies": {
    "__SCOPE__/api": "workspace:*",
    "@types/react": "catalog:",
    "@types/react-dom": "catalog:",
    "@vitejs/plugin-react": "catalog:",
    "vite": "catalog:"
  }
}
EOF
emit apps/web/tsconfig.json <<'EOF'
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "lib": ["ES2024", "DOM", "DOM.Iterable"],
    // "node": AppType is inferred from the api source, which needs Node types.
    "types": ["vite/client", "node"]
  },
  "include": ["src", "vite.config.ts"]
}
EOF
emit apps/web/vite.config.ts <<'EOF'
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // API_URL is set per worktree by paseo.json; defaults to the local API.
  server: { proxy: { "/api": process.env.API_URL ?? "http://localhost:3000" } },
});
EOF
emit apps/web/index.html <<'EOF'
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
EOF
emit apps/web/src/lib/api.ts <<'EOF'
import type { AppType } from "__SCOPE__/api";
import { hc } from "hono/client";

/** Single entry point to the API. Endpoints and types are inferred from the Hono app. */
export const api = hc<AppType>("/").api;
EOF
emit apps/web/src/main.tsx <<'EOF'
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { api } from "./lib/api.ts";

function Health() {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: async () => (await api.health.$get()).json(),
  });
  if (health.isPending) return <p>Loading…</p>;
  if (health.isError) return <p>API unreachable.</p>;
  return (
    <p>
      API: {health.data.status} · DB: {health.data.db}
    </p>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={new QueryClient()}>
      <h1>Hello</h1>
      <Health />
    </QueryClientProvider>
  </StrictMode>,
);
EOF

