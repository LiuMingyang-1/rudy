import assert from "node:assert/strict";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { Task } from "../../src/protocol/task.ts";
import { day3, fakeClock, git } from "./day3-fixture.ts";
import { cli } from "./fixture.ts";

test("Git tasks use pinned independent worktrees and can run in parallel", async (t) => {
  const d = await day3(t);
  await d.open();
  const first = await d.submit("gated first");
  const second = JSON.parse(
    (
      await cli(
        d.f,
        "submit",
        "--workspace",
        d.f.root,
        "--base",
        "main",
        "--goal",
        "gated second",
        "--completion",
        "Report the result",
      )
    ).stdout,
  ) as Task;
  await Promise.all([d.running(first.taskId), d.running(second.taskId)]);
  assert.ok(first.git && second.git);
  assert.notEqual(first.git.worktree, second.git.worktree);
  assert.notEqual(first.git.branch, second.git.branch);
  for (const task of [first.git, second.git]) {
    assert.equal(task.repository, d.f.root);
    assert.equal(task.baseline, d.base);
    assert.equal(git(task.worktree, "rev-parse", "HEAD"), d.base);
    await writeFile(join(task.worktree, "release"), "");
  }
  await Promise.all([d.state(first.taskId, "succeeded"), d.state(second.taskId, "succeeded")]);
  assert.equal(await readFile(join(d.f.root, "file.txt"), "utf8"), "baseline\n");
  assert.equal(git(d.f.root, "status", "--short"), "");
  const detail = await d.show(first.taskId);
  assert.ok(detail.evidence);
  assert.match(detail.evidence.diff, /\+task change/);
  assert.match(detail.evidence.diff, /\+untracked change/);
  assert.equal(detail.evidence.commit, git(first.git.worktree, "rev-parse", "HEAD"));
  assert.deepEqual(detail.evidence.commands, [{ command: "npm run check", exitCode: 0 }]);
  assert.equal(detail.executions[0].result, "Agent report with an open question");
});

test("serial review receives persisted evidence, runs read-only, and gates the confirmed merge", async (t) => {
  const d = await day3(t);
  await d.open();
  const file = join(d.f.temporary, "group.json");
  await writeFile(
    file,
    JSON.stringify({
      tasks: [
        d.plan("gated fix"),
        { goal: "hold review", completion: "Report review", review: true, harness: "claude-code" },
        { goal: "review in Codex", completion: "Report review", review: true },
      ],
    }),
  );
  const [fix, review, last]: Task[] = JSON.parse((await cli(d.f, "group", file)).stdout);
  assert.ok(fix.git);
  assert.deepEqual(review.git, fix.git);
  assert.equal(review.after, fix.taskId);
  await d.running(fix.taskId);
  assert.equal((await d.show(review.taskId)).executions.length, 0);
  await writeFile(join(fix.git.worktree, "release"), "");
  await d.running(review.taskId);
  const detail = await d.show(fix.taskId);
  assert.ok(detail.evidence);
  const args = [
    "merge",
    fix.taskId,
    "--commit",
    detail.evidence.commit,
    "--target",
    "main",
    "--target-head",
    d.base,
  ];
  await assert.rejects(cli(d.f, ...args), /execution still occupies/);
  await writeFile(join(d.f.temporary, "release-review"), "");
  await d.state(last.taskId, "succeeded");
  const reviewed = await d.show(review.taskId);
  assert.equal(reviewed.evidence?.upstreamExecutionId, detail.executions[0].executionId);
  assert.equal(reviewed.executions[0].result, "Reviewed the change.");
  const { head } = JSON.parse((await cli(d.f, ...args)).stdout);
  assert.equal(head, detail.evidence.commit);
  assert.equal(await readFile(join(d.f.root, "file.txt"), "utf8"), "task change\n");
  assert.match((await cli(d.f, "events", fix.taskId)).stdout, /task\.merged/);
});

test("failed or canceled predecessors do not release reviews; unsupported restrictions fail startup", async (t) => {
  const d = await day3(t);
  await d.open();
  for (const [goal, status] of [
    ["fail upstream", "failed"],
    ["gated stop", "canceled"],
  ] as const) {
    const [fix, review] = (await d.api("/groups", "POST", {
      tasks: [d.plan(goal), { goal: "review in Codex", completion: "Review", review: true }],
    })) as Task[];
    if (status === "canceled") {
      await d.running(fix.taskId);
      await d.api(`/tasks/${fix.taskId}/stop`, "POST");
    }
    await d.state(fix.taskId, status);
    const detail = await d.show(review.taskId);
    assert.equal(detail.task.status, "waiting");
    assert.match(detail.task.reason ?? "", new RegExp(status));
    assert.deepEqual(detail.executions, []);
  }
  const [, review] = (await d.api("/groups", "POST", {
    tasks: [d.plan("write"), { goal: "reject restriction", completion: "Review", review: true }],
  })) as Task[];
  await d.state(review.taskId, "failed");
  assert.match(
    (await d.show(review.taskId)).task.reason ?? "",
    /unrecognized option --strict-config/,
  );
  assert.equal((await d.show(review.taskId)).executions[0].nativeSessionId, null);
});

test("active review prevents a second execution in its worktree", async (t) => {
  const d = await day3(t);
  await d.open();
  const [fix, review] = (await d.api("/groups", "POST", {
    tasks: [
      d.plan("write"),
      { goal: "hold review", completion: "Review", review: true, harness: "claude-code" },
    ],
  })) as Task[];
  await d.running(review.taskId);
  await d.api(`/tasks/${fix.taskId}/resume`, "POST");
  const pending = await d.show(fix.taskId);
  assert.equal(pending.task.status, "queued");
  assert.equal(pending.executions.length, 1);
  await writeFile(join(d.f.temporary, "release-review"), "");
  await d.state(fix.taskId, "succeeded");
  assert.equal((await d.show(fix.taskId)).executions.length, 2);
});

test("managed worktree replacement by a symlink fails before the harness starts", async (t) => {
  const clock = fakeClock();
  const d = await day3(t, clock);
  await d.open();
  const task = (await d.api("/tasks", "POST", {
    ...d.plan("write"),
    waitUntil: clock.now() + 100,
  })) as Task;
  assert.ok(task.git);
  await symlink(d.f.root, task.git.worktree);
  clock.advance(100);
  await d.state(task.taskId, "failed");
  const detail = await d.show(task.taskId);
  assert.match(detail.task.reason ?? "", /canonical Git repository root/);
  assert.equal(detail.executions[0].nativeSessionId, null);
  assert.equal(git(d.f.root, "status", "--short"), "");
});
