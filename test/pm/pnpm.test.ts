import { expect, it } from "vitest";
import { PM_NAMES } from "../../src/pm/index.ts";
import { createPnpmAdapter } from "../../src/pm/pnpm.ts";
import { adapterContract } from "./contract.ts";

for (const name of PM_NAMES) adapterContract(name);

const pnpm = createPnpmAdapter(async () => "9.9.9");

it("pnpm commands", () => {
  expect(pnpm.commands).toEqual({
    install: ["pnpm", "install"],
    run: ["pnpm"],
    exec: ["pnpm", "exec"],
  });
});

it("pnpm token values", () => {
  expect(pnpm.tokens).toEqual({
    __RUN_SILENT__: "pnpm -s",
    __FILTER__: "pnpm --filter",
    __INSTALL_FROZEN__: "pnpm install --frozen-lockfile",
    __PM_ENSURE__:
      'command -v pnpm >/dev/null || corepack enable --install-directory \\"$HOME/.local/bin\\" pnpm',
    __CI_SETUP__: `      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v5
        with:
          node-version-file: .nvmrc
          cache: pnpm`,
    __ADD_DEP__: "pnpm add <pkg> --filter",
  });
});

it("pnpm keeps its catalog in pnpm-workspace.yaml", () => {
  expect(pnpm.files).toEqual(["pnpm-workspace.yaml"]);
  expect(pnpm.catalogFile).toBe("pnpm-workspace.yaml");
  expect(pnpm.renderFiles({ "@biomejs/biome": "^2.0.0", typescript: "~5.0.0" })).toEqual({
    "pnpm-workspace.yaml": `packages:
  - "apps/*"
  - "packages/*"

# All external versions live here; package.json files only use "catalog:".
catalogMode: strict
catalog:
  "@biomejs/biome": "^2.0.0"
  "typescript": "~5.0.0"

# Packages allowed to run install scripts
allowBuilds:
  esbuild: true
`,
  });
});
