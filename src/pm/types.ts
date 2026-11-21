/** A command to run: executable plus arguments. */
export type Command = readonly [cmd: string, ...args: string[]];
/** Package name → version range, sorted by name. */
export type Catalog = Readonly<Record<string, string>>;

/** Template tokens whose values only an adapter knows. Core tokens live in scaffold.ts. */
export const ADAPTER_TOKENS = [
  "__RUN_SILENT__",
  "__FILTER__",
  "__INSTALL_FROZEN__",
  "__PM_ENSURE__",
  "__CI_SETUP__",
  "__ADD_DEP__",
] as const;
export type AdapterToken = (typeof ADAPTER_TOKENS)[number];

/**
 * Everything package-manager specific. The scaffold core and the templates never mention a
 * package manager by name; adding one means adding an adapter and a table entry.
 */
export interface PackageManagerAdapter {
  readonly name: string;
  /** The package manager's own version. */
  version(): Promise<string>;
  /** argv prefixes for the commands the scaffold spawns. */
  readonly commands: {
    readonly install: Command;
    readonly run: Command;
    readonly exec: Command;
  };
  /** Values for ADAPTER_TOKENS. A value is literal text and must not contain `__X__` tokens. */
  readonly tokens: Readonly<Record<AdapterToken, string>>;
  /** Paths the adapter writes itself. They must not overlap any template destination. */
  readonly files: readonly string[];
  /** The path that holds the version catalog: one of `files` or a template destination. */
  readonly catalogFile: string;
  /** Contents for every path in `files`. */
  renderFiles(catalog: Catalog): Readonly<Record<string, string>>;
}
