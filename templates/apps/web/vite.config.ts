import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
@if api
  // API_URL is set per worktree by paseo.json; defaults to the local API.
  server: { proxy: { "/api": process.env.API_URL ?? "http://localhost:3000" } },
@endif
});
