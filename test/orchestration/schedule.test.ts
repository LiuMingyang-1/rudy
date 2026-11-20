import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { Task } from "../../src/protocol/task.ts";
import { day3, fakeClock, git } from "./day3-fixture.ts";
import { cli } from "./fixture.ts";

test("absolute wait survives restart and uses the baseline resolved at submission", async (t) => {
  const clock = fakeClock();
  const d = await day3(t, clock);
  const host = await d.open();
  const at = clock.now() + 1000;
  const { taskId } = JSON.parse(
    (
      await cli(
        d.f,
        "submit",
        "--workspace",
        d.f.root,
        "--goal",
        "scheduled",
        "--completion",
        "Report",
        "--base",
        "main",
        "--at",
        new Date(at).toISOString(),
      )
    ).stdout,
  ) as Task;
  assert.match((await d.show(taskId)).task.reason ?? "", /Waiting until/);
  await host.close();
  git(d.f.root, "commit", "--allow-empty", "-qm", "advanced main");
  clock.advance(999);
  await d.open();
  assert.equal((await d.show(taskId)).executions.length, 0);
  clock.advance(1);
  await d.state(taskId, "succeeded");
  const { evidence, task } = await d.show(taskId);
  assert.equal(task.waitUntil, at);
  assert.equal(task.git?.baseline, d.base);
  assert.equal(git(d.f.root, "rev-parse", `${evidence?.commit}^`), d.base);
});

test("routine trigger deduplicates across restart, catches up once, skips overlap, and can pause", async (t) => {
  const clock = fakeClock();
  const d = await day3(t, clock);
  const host = await d.open();
  const { id } = JSON.parse(
    (
      await cli(
        d.f,
        "routine",
        "--every",
        "1000",
        "--workspace",
        d.f.root,
        "--goal",
        "gated recurring",
        "--completion",
        "Report",
        "--base",
        "main",
      )
    ).stdout,
  );
  const tasks = async () => (await d.api("/tasks")) as Task[];
  const triggers = async () =>
    (
      (await d.api("/routines")) as {
        id: string;
        enabled: boolean;
        triggers: { scheduledAt: number; taskId: string | null }[];
      }[]
    ).find((routine) => routine.id === id);
  assert.deepEqual(await tasks(), []);
  await host.close();
  clock.advance(3500);
  const missed = clock.now() - 500;
  const restart = await d.open();
  const [first] = await tasks();
  assert.ok(first.git);
  assert.deepEqual((await triggers())?.triggers, [{ scheduledAt: missed, taskId: first.taskId }]);
  await d.running(first.taskId);
  await writeFile(join(first.git.worktree, "release"), "");
  await d.state(first.taskId, "succeeded");

  await restart.close();
  await d.open();
  assert.equal((await tasks()).length, 1);
  assert.equal((await triggers())?.triggers.length, 1);
  clock.advance(500);
  const [, second] = await tasks();
  assert.ok(second.git);
  await d.running(second.taskId);
  clock.advance(1000);
  assert.deepEqual((await triggers())?.triggers.at(-1), { scheduledAt: clock.now(), taskId: null });
  assert.equal((await tasks()).length, 2);
  await writeFile(join(second.git.worktree, "release"), "");
  await d.state(second.taskId, "succeeded");

  await cli(d.f, "routine-pause", id);
  clock.advance(3500);
  assert.equal((await triggers())?.enabled, false);
  assert.equal((await tasks()).length, 2);
  await cli(d.f, "routine-resume", id);
  const [, , next] = await tasks();
  assert.equal(next.routineId, id);
  assert.deepEqual((await triggers())?.triggers.at(-1), {
    scheduledAt: clock.now() - 500,
    taskId: next.taskId,
  });
  assert.equal((await tasks()).length, 3);
});
