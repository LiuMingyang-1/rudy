import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export function contains(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export async function directory(path: string): Promise<string> {
  const target = await realpath(path);
  if (!(await stat(target)).isDirectory()) throw new Error("Workspace must be a directory.");
  return target;
}

export async function validateWorkspace(root: string, input: string): Promise<string> {
  const requested = resolve(root, input);
  if (contains(root, requested)) {
    const target = await directory(requested);
    if (!contains(root, target)) throw new Error("Workspace resolves outside the configured root.");
    return target;
  }
  // Absolute paths can use an alias of the root, such as macOS /var for /private/var.
  const target = isAbsolute(input) ? await directory(requested).catch(() => undefined) : undefined;
  if (!target || !contains(root, target)) {
    throw new Error("Workspace is outside the configured root.");
  }
  return target;
}
