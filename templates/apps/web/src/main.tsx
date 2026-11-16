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
