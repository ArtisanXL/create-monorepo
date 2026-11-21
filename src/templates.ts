import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

export const TEMPLATES_DIR = fileURLToPath(new URL("../templates/", import.meta.url));

/** Template trees written into the target, in order. */
const TEMPLATE_TREES = ["root", "packages", "apps"] as const;

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

export interface TemplateFile {
  /** Path relative to the templates dir, e.g. `root/_gitignore`. */
  src: string;
  /** Path in the generated repo. */
  dest: string;
  text: string;
  /** The template starts with a shebang. */
  executable: boolean;
}

/** Template files starting with `_` are dotfiles (npm would drop real ones when packing). */
export function destinationOf(templatePath: string): string {
  return templatePath
    .split("/")
    .map((seg) => (seg.startsWith("_") ? `.${seg.slice(1)}` : seg))
    .join("/");
}

export const isExecutable = (text: string): boolean => text.startsWith("#!");

async function walk(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await walk(dir, path)));
    else out.push(path);
  }
  return out.sort();
}

/** Every file that gets generated into the target (excluding CLAUDE.md and the workspace file). */
export async function listTemplateFiles(templatesDir = TEMPLATES_DIR): Promise<TemplateFile[]> {
  const out: TemplateFile[] = [];
  for (const tree of TEMPLATE_TREES) {
    const prefix = tree === "root" ? "" : `${tree}/`;
    for (const rel of await walk(join(templatesDir, tree))) {
      const src = `${tree}/${rel}`;
      const text = await readFile(join(templatesDir, src), "utf8");
      out.push({
        src,
        dest: destinationOf(`${prefix}${rel}`),
        text,
        executable: isExecutable(text),
      });
    }
  }
  return out;
}

/** Distinct package names that templates depend on via `"catalog:"`, sorted. */
export function catalogPackagesOf(files: Iterable<{ dest: string; text: string }>): string[] {
  const names = new Set<string>();
  for (const { dest, text } of files) {
    if (basename(dest) !== "package.json") continue;
    const pkg = JSON.parse(text) as Record<string, unknown>;
    for (const field of DEPENDENCY_FIELDS) {
      const deps = pkg[field];
      if (!deps || typeof deps !== "object") continue;
      for (const [name, range] of Object.entries(deps)) if (range === "catalog:") names.add(name);
    }
  }
  return [...names].sort();
}

export async function catalogPackages(templatesDir = TEMPLATES_DIR): Promise<string[]> {
  return catalogPackagesOf(await listTemplateFiles(templatesDir));
}
