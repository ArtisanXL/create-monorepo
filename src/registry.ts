type Fetch = (url: string | URL) => Promise<Response>;

/** Resolves the exact latest stable version of a package from the npm registry. */
export function createRegistryResolver(fetchImpl: Fetch = fetch) {
  return async (pkg: string): Promise<string> => {
    let version: unknown;
    try {
      const res = await fetchImpl(`https://registry.npmjs.org/${pkg}/latest`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      version = ((await res.json()) as { version?: unknown }).version;
    } catch (error) {
      throw new Error(`Could not resolve version: ${pkg} (${(error as Error).message})`);
    }
    if (typeof version !== "string" || version === "") {
      throw new Error(`Could not resolve version: ${pkg} (no version in registry response)`);
    }
    return version;
  };
}
