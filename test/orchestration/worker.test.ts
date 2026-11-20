import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { Task, TaskEvent } from "../../src/protocol/task.ts";
import { reconnecting } from "../../src/protocol/worker.ts";
import { pairWorker } from "../../src/worker/client.ts";
import { day4, fakePeer } from "./day4-fixture.ts";
import { cli, waitFor } from "./fixture.ts";

test("pairs once, selects by repository and harness, reviews and merges on the Worker", async (t) => {
  const d = await day4(t);
  await assert.rejects(pairWorker(d.address, d.code), /pairing was refused/);
  const worker = await d.worker();
  assert.deepEqual(JSON.parse((await cli(d.f, "devices")).stdout), [
    {
      device: d.identity.device,
      online: true,
      name: "fixture-worker",
      repositories: ["project"],
      harnesses: ["codex", "claude-code"],
    },
  ]);
  await assert.rejects(
    d.api("/tasks", "POST", { ...d.plan("escape"), workspace: d.hostRoot }),
    /repository alias and no workspace path/,
  );
  const explicit = JSON.parse(
    (
      await cli(
        d.f,
        "submit",
        "--device",
        d.identity.device,
        "--repository",
        "project",
        "--base",
        "main",
        "--goal",
        "probe",
        "--completion",
        "Report",
      )
    ).stdout,
  ) as Task;
  await d.state(explicit.taskId, "succeeded");
  assert.equal((await d.show(explicit.taskId)).executions[0].device, d.identity.device);

  const [fix, review] = (await d.api("/groups", "POST", {
    tasks: [
      { ...d.plan("gated remote change"), baseline: "main" },
      { goal: "Check the change", completion: "Review", review: true, harness: "claude-code" },
    ],
  })) as Task[];
  await d.running(fix.taskId);
  const active = await d.show(fix.taskId);
  assert.equal(active.task.brief.workspace, "project");
  assert.equal(active.task.git?.repository, d.f.root);
  assert.equal(active.task.git?.baseline, d.base);
  assert.ok(active.task.git?.worktree);
  const events = (await d.api(`/tasks/${fix.taskId}/events`)) as TaskEvent[];
  assert.deepEqual(
    events.slice(1, 3).map(({ type }) => type),
    ["execution.dispatched", "execution.received"],
  );
  assert.ok(events.some(({ type }) => type === "execution.started"));
  await writeFile(join(active.task.git.worktree, "release"), "");
  await d.state(review.taskId, "succeeded");
  const result = await d.show(review.taskId);
  assert.equal(result.executions[0].device, d.identity.device);
  assert.equal(result.task.git?.worktree, active.task.git.worktree);
  assert.match(result.evidence?.diff ?? "", /task change/);
  assert.equal(await readFile(join(d.f.root, "file.txt"), "utf8"), "baseline\n");
  const commit = result.evidence?.commit;
  assert.ok(commit);
  assert.deepEqual(
    await d.api(`/tasks/${fix.taskId}/merge`, "POST", {
      commit,
      target: "main",
      targetHead: d.base,
    }),
    { head: commit },
  );
  assert.equal(await readFile(join(d.f.root, "file.txt"), "utf8"), "task change\n");

  await cli(d.f, "revoke", d.identity.device);
  await worker.done;
  assert.deepEqual(await d.api("/devices"), []);
  const freshCode = (await cli(d.f, "pair-code")).stdout.trim();
  const pairedAgain = await pairWorker(d.address, freshCode, d.identity);
  assert.equal(pairedAgain.device, d.identity.device);
});

test("a real Worker reconnects and replays its original execution after Host restart", async (t) => {
  const d = await day4(t);
  const worker = await d.worker();
  const task = await d.submit("gated");
  await d.running(task.taskId);
  const id = (await d.show(task.taskId)).executions[0].executionId;
  worker.disconnect();
  await waitFor(async () => (await d.show(task.taskId)).task.reason === reconnecting);
  await waitFor(async () => (await d.show(task.taskId)).task.reason === null);
  assert.equal((await d.show(task.taskId)).executions[0].executionId, id);
  await d.host.close();
  await writeFile(join(d.f.root, "release"), "");
  // The Worker continues against its own SQLite journal with no Host socket.
  await waitFor(
    async () => (await readFile(join(d.f.root, "file.txt"), "utf8")) === "task change\n",
  );
  await d.open(d.host.workerPort);
  await d.state(task.taskId, "succeeded");
  const detail = await d.show(task.taskId);
  assert.deepEqual(
    detail.executions.map((execution) => execution.executionId),
    [id],
  );
  const events = (await d.api(`/tasks/${task.taskId}/events`)) as TaskEvent[];
  assert.equal(events.filter(({ type }) => type === "execution.started").length, 1);
  assert.equal(events.filter(({ type }) => type === "execution.finished").length, 1);
  assert.equal(detail.executions[0].result, "Agent report with an open question");
});

test("preserves unknown ownership, deduplicates replay, and ignores a late finish after retry", async (t) => {
  const d = await day4(t);
  const connect = async (held?: Parameters<typeof fakePeer>[2]) => {
    const peer = await fakePeer(d.address, d.identity, held);
    t.after(peer.disconnect);
    await d.online();
    return peer;
  };
  const first = await connect();
  const task = await d.submit("remote test");
  const claimed = await first.dispatch(task);
  const id = claimed.id;
  assert.equal((await d.show(task.taskId)).executions[0].executionId, id);
  const accepted = { type: "event", id, seq: 1, event: { type: "execution.received" } } as const;
  first.send(accepted);
  await waitFor(async () => first.received.some((m) => m.type === "ack" && m.seq === 1));
  first.disconnect();
  await waitFor(async () => (await d.show(task.taskId)).task.reason === reconnecting);
  d.clock.advance(15_001);
  await d.state(task.taskId, "waiting");

  const unknown = await connect();
  assert.match(
    (await d.show(task.taskId)).task.reason ?? "",
    /Previous execution state is unknown/,
  );
  await assert.rejects(d.api(`/tasks/${task.taskId}/resume`, "POST"), /Waiting for device/);
  const second = await d.submit("another writer");
  assert.deepEqual((await d.show(second.taskId)).executions, []);
  assert.equal((await d.show(task.taskId)).executions[0].endedAt, null);
  await d.api(`/tasks/${second.taskId}/stop`, "POST");
  unknown.disconnect();
  await waitFor(
    async () => ((await d.api("/devices")) as { online: boolean }[])[0]?.online === false,
  );

  const missing = await connect([{ id, last: 2, acknowledged: 2 }]);
  assert.match((await d.show(task.taskId)).task.reason ?? "", /event history has a gap/);
  missing.disconnect();
  await waitFor(
    async () => ((await d.api("/devices")) as { online: boolean }[])[0]?.online === false,
  );

  const restored = await connect([{ id, last: 2, acknowledged: 0 }]);
  await d.state(task.taskId, "running");
  restored.send(accepted);
  const finish = {
    type: "event",
    id,
    seq: 2,
    event: {
      type: "execution.finished",
      status: "failed",
      reason: "fixture failure",
      result: null,
    },
  } as const;
  restored.send(finish);
  await d.state(task.taskId, "failed");
  await d.api(`/tasks/${task.taskId}/resume`, "POST");
  await waitFor(async () => (await d.show(task.taskId)).executions.length === 2);
  restored.send({ ...finish, seq: 3, event: { ...finish.event, status: "succeeded" } });
  await waitFor(
    async () => restored.received.filter((m) => m.type === "ack" && m.seq === 2).length === 2,
  );
  const events = (await d.api(`/tasks/${task.taskId}/events`)) as TaskEvent[];
  assert.equal(events.filter(({ type }) => type === "execution.received").length, 1);
  assert.equal(events.filter(({ type }) => type === "execution.finished").length, 1);
  assert.equal((await d.show(task.taskId)).task.status, "running");
});
