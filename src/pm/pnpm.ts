import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Catalog, PackageManagerAdapter } from "./types.ts";

const execFileAsync = promisify(execFile);

async function installedPnpmVersion(): Promise<string> {
  const { stdout } = await execFileAsync("pnpm", ["-v"], { shell: process.platform === "win32" });
  return stdout.trim();
}

function renderWorkspaceYaml(catalog: Catalog): string {
  const entries = Object.entries(catalog)
    .map(([pkg, range]) => `  "${pkg}": "${range}"\n`)
    .join("");
  return `packages:
  - "apps/*"
  - "packages/*"

# All external versions live here; package.json files only use "catalog:".
catalogMode: strict
catalog:
${entries}
# Packages allowed to run install scripts
allowBuilds:
  esbuild: true
${"wrangler" in catalog ? "  workerd: true\n" : ""}`;
}

export function createPnpmAdapter(
  getVersion: () => Promise<string> = installedPnpmVersion,
): PackageManagerAdapter {
  return {
    name: "pnpm",
    version: getVersion,
    commands: { install: ["pnpm", "install"], run: ["pnpm"], exec: ["pnpm", "exec"] },
    tokens: {
      __RUN_SILENT__: "pnpm -s",
      __FILTER__: "pnpm --filter",
      __INSTALL_FROZEN__: "pnpm install --frozen-lockfile",
      __PM_ENSURE__:
        'command -v pnpm >/dev/null || corepack enable --install-directory \\"$HOME/.local/bin\\" pnpm',
      __CI_SETUP__: [
        "      - uses: pnpm/action-setup@v4",
        "      - uses: actions/setup-node@v5",
        "        with:",
        "          node-version-file: .nvmrc",
        "          cache: pnpm",
      ].join("\n"),
      __ADD_DEP__: "pnpm add <pkg> --filter",
    },
    files: ["pnpm-workspace.yaml"],
    catalogFile: "pnpm-workspace.yaml",
    renderFiles: (catalog) => ({ "pnpm-workspace.yaml": renderWorkspaceYaml(catalog) }),
  };
}
