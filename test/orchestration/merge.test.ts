import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { day3, git } from "./day3-fixture.ts";

test("merge refuses a dirty target, changed target or result commit, and a conflict without losing work", async (t) => {
  const d = await day3(t);
  await d.open();
  const task = await d.submit("write");
  await d.state(task.taskId, "succeeded");
  const { evidence } = await d.show(task.taskId);
  assert.ok(evidence && task.git);
  const { worktree, branch } = task.git;
  const merge = (targetHead: string, commit = evidence.commit) =>
    d.api(`/tasks/${task.taskId}/merge`, "POST", { targetHead, target: "main", commit });

  await writeFile(join(d.f.root, "file.txt"), "target change\n");
  await assert.rejects(merge(d.base), /uncommitted changes/);
  assert.equal(await readFile(join(d.f.root, "file.txt"), "utf8"), "target change\n");
  assert.equal(git(d.f.root, "rev-parse", "HEAD"), d.base);
  git(d.f.root, "commit", "-qam", "conflicting target");
  const targetHead = git(d.f.root, "rev-parse", "HEAD");
  await assert.rejects(merge(d.base), /Target branch moved/);
  await assert.rejects(merge(targetHead, targetHead), /current successful Git task result/);
  await assert.rejects(merge(targetHead), /merge conflict/);
  assert.equal(git(d.f.root, "rev-parse", "HEAD"), targetHead);
  assert.equal(git(d.f.root, "status", "--short"), "");
  assert.equal(await readFile(join(d.f.root, "file.txt"), "utf8"), "target change\n");
  assert.equal(git(worktree, "rev-parse", branch), evidence.commit);
  assert.equal(await readFile(join(worktree, "file.txt"), "utf8"), "task change\n");

  git(worktree, "commit", "--allow-empty", "-qm", "result branch moved");
  await assert.rejects(merge(targetHead), /Result worktree changed/);
  assert.equal(git(worktree, "status", "--short"), "");
  assert.notEqual(git(worktree, "rev-parse", branch), evidence.commit);
  assert.equal(git(d.f.root, "rev-parse", "HEAD"), targetHead);
});
