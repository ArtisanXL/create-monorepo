import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PackageManagerAdapter } from "./types.ts";

const execFileAsync = promisify(execFile);

async function installedPnpmVersion(): Promise<string> {
  const { stdout } = await execFileAsync("pnpm", ["-v"]);
  return stdout.trim();
}

export function createPnpmAdapter(
  getVersion: () => Promise<string> = installedPnpmVersion,
): PackageManagerAdapter {
  return {
    name: "pnpm",
    workspaceFile: "pnpm-workspace.yaml",
    version: getVersion,
    packageManagerField: (version) => `pnpm@${version}`,
    renderWorkspaceFile(catalog) {
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
`;
    },
    installCommand: () => ["pnpm", "install"],
    formatCommand: (files) => [
      "pnpm",
      "exec",
      "biome",
      "check",
      "--write",
      "--files-ignore-unknown=true",
      "--no-errors-on-unmatched",
      ...files,
    ],
    verifyCommand: () => ["pnpm", "verify"],
  };
}
