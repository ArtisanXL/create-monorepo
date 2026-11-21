import { createPnpmAdapter } from "./pnpm.ts";
import type { PackageManagerAdapter } from "./types.ts";

type AdapterFactory = (getVersion?: () => Promise<string>) => PackageManagerAdapter;

/** The single list of supported package managers. */
export const PACKAGE_MANAGERS = {
  pnpm: (getVersion) => createPnpmAdapter(getVersion),
} as const satisfies Record<string, AdapterFactory>;

export type PmName = keyof typeof PACKAGE_MANAGERS;
export const PM_NAMES = Object.keys(PACKAGE_MANAGERS) as PmName[];
export const isPmName = (s: string): s is PmName => Object.hasOwn(PACKAGE_MANAGERS, s);
export const createAdapter = (name: PmName, getVersion?: () => Promise<string>) =>
  PACKAGE_MANAGERS[name](getVersion);
