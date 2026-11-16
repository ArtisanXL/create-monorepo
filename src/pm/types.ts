/** A command to run: executable plus arguments. */
export type Command = readonly [cmd: string, ...args: string[]];

/**
 * Everything package-manager specific. The scaffold core never mentions a
 * package manager by name; adding one means adding an adapter.
 */
export interface PackageManagerAdapter {
  readonly name: string;
  /** Workspace/catalog file path, relative to the target. */
  readonly workspaceFile: string;
  /** The package manager's own version (used for the `packageManager` field). */
  version(): Promise<string>;
  /** Value for package.json `packageManager`. */
  packageManagerField(version: string): string;
  /** Contents of the workspace/catalog file; `catalog` maps package to version range. */
  renderWorkspaceFile(catalog: Readonly<Record<string, string>>): string;
  installCommand(): Command;
  /** Format only the given (relative) files. */
  formatCommand(files: readonly string[]): Command;
  verifyCommand(): Command;
}
