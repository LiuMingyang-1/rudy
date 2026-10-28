import { open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

const fileParameters = Type.Object({
  path: Type.String({ description: "Path relative to the workspace; use . for its root." }),
});

/** Create read-only tools scoped to an existing workspace directory. */
export async function createFileTools(workspace: string) {
  const root = await realpath(workspace);
  if (!(await stat(root)).isDirectory()) {
    throw new Error("RUDY_WORKSPACE must be a directory.");
  }
  const tools: AgentTool<typeof fileParameters, { path: string }>[] = [
    {
      name: "list_files",
      label: "List files",
      description: "List up to 100 visible entries in a workspace directory, without recursion.",
      parameters: fileParameters,
      execute: async (_id, { path }, signal) => {
        signal?.throwIfAborted();
        const target = await workspacePath(root, path);
        const entries = (await readdir(target, { withFileTypes: true }))
          .filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules")
          .sort((a, b) => a.name.localeCompare(b.name));
        const lines = entries.slice(0, 100).map((entry) => {
          const suffix = entry.isDirectory() ? "/" : entry.isSymbolicLink() ? "@" : "";
          return entry.name + suffix;
        });
        if (entries.length > 100) lines.push(`... ${entries.length - 100} more entries omitted.`);
        return {
          content: [{ type: "text", text: lines.join("\n") || "(empty directory)" }],
          details: { path },
        };
      },
    },
    {
      name: "read_file",
      label: "Read file",
      description: "Read a UTF-8 text file of up to 64 KiB inside the workspace.",
      parameters: fileParameters,
      execute: async (_id, { path }, signal) => {
        signal?.throwIfAborted();
        const target = await workspacePath(root, path);
        const handle = await open(target, "r");
        try {
          const info = await handle.stat();
          if (!info.isFile()) throw new Error("Path must be a regular text file.");
          if (info.size > 64 * 1024) throw new Error("File exceeds the 64 KiB read limit.");
          const text = await handle.readFile({ encoding: "utf8", signal });
          if (text.includes("\0")) throw new Error("Binary files are not supported.");
          return { content: [{ type: "text", text }], details: { path } };
        } finally {
          await handle.close();
        }
      },
    },
  ];
  return tools;
}

async function workspacePath(root: string, input: string): Promise<string> {
  // Model-supplied paths must stay in the workspace, including symlink targets.
  const requested = resolve(root, input);
  checkPath(root, requested);
  const target = await realpath(requested);
  checkPath(root, target);
  return target;
}

function checkPath(root: string, target: string): void {
  const path = relative(root, target);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error("Path is outside the workspace.");
  }
  if (path.split(sep).some((part) => part.startsWith(".") || part === "node_modules")) {
    throw new Error("Hidden paths and node_modules are not available to Rudy.");
  }
}
