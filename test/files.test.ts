import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFileTools } from "../src/tools/files.ts";

test("file tools read workspace text and omit hidden files from listings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rudy-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "notes.txt"), "Remember to review the PR.");
  await writeFile(join(root, ".env"), "API_KEY=private");
  await mkdir(join(root, "node_modules"));
  const [list, read] = await createFileTools(root);
  const result = await read.execute("read", { path: "notes.txt" });
  assert.deepEqual(result.content, [{ type: "text", text: "Remember to review the PR." }]);
  const entries = await list.execute("list", { path: "." });
  assert.deepEqual(entries.content, [{ type: "text", text: "notes.txt" }]);
});

test("file tools reject path traversal, hidden paths and escaping symlinks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rudy-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(root, "outside.txt"), "outside");
  await writeFile(join(workspace, ".env"), "private");
  await symlink(join(root, "outside.txt"), join(workspace, "link.txt"));
  await symlink(join(workspace, ".env"), join(workspace, "secret.txt"));
  const [list, read] = await createFileTools(workspace);
  await assert.rejects(read.execute("read", { path: "../outside.txt" }), /outside/);
  await assert.rejects(read.execute("read", { path: join(root, "outside.txt") }), /outside/);
  await assert.rejects(read.execute("read", { path: "link.txt" }), /outside/);
  await assert.rejects(read.execute("read", { path: ".env" }), /Hidden/);
  await assert.rejects(read.execute("read", { path: "secret.txt" }), /Hidden/);
  await assert.rejects(list.execute("list", { path: ".." }), /outside/);
});

test("file tools reject oversized, binary and non-file reads", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rudy-limits-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "large.txt"), "x".repeat(64 * 1024 + 1));
  await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2]));
  const [, read] = await createFileTools(root);
  await assert.rejects(read.execute("read", { path: "large.txt" }), /64 KiB/);
  await assert.rejects(read.execute("read", { path: "binary.bin" }), /Binary/);
  await assert.rejects(read.execute("read", { path: "." }), /regular text file/);
  await assert.rejects(createFileTools(join(root, "large.txt")), /must be a directory/);
});
