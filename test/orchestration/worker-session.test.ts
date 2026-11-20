import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { HostMessage } from "../../src/protocol/worker.ts";
import { type Frame, WorkerJournal } from "../../src/worker/journal.ts";
import { workerSession } from "../../src/worker/session.ts";
import { fixture, waitFor } from "./fixture.ts";

test("Worker replays a duplicate execution ID without starting another harness", async (t) => {
  const f = await fixture(t);
  f.root = await realpath(f.root);
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const device = randomUUID();
  const frames: Frame[] = [];
  const journal = new WorkerJournal(db, device);
  let launches = 0;
  const session = workerSession({
    device,
    root: f.root,
    dataDir: f.dataDir,
    worktrees: join(f.dataDir, "worktrees"),
    repositories: new Map([["project", f.root]]),
    journal,
    harnesses: {
      codex: async (turn, _signal, report) => {
        assert.equal(turn.workspace, f.root);
        launches++;
        report({ type: "execution.progress", message: "fixture output" });
        return "completed";
      },
    },
    send(message) {
      if (message.type === "event") frames.push(message);
    },
    onStorageFailure: () => assert.fail("Could not write Worker journal"),
  });
  const dispatch: HostMessage = {
    type: "dispatch",
    id: randomUUID(),
    input: {
      task: {
        taskId: randomUUID(),
        harness: "codex",
        status: "queued",
        reason: null,
        brief: { goal: "probe", workspace: "project", completion: "Report" },
        remote: { device, repository: "project" },
        createdAt: new Date().toISOString(),
      },
      history: [],
      checkpoint: null,
    },
  };
  session.receive(dispatch);
  session.receive(dispatch);
  await waitFor(async () => frames.some(({ event }) => event.type === "execution.finished"));
  assert.equal(launches, 1);
  assert.deepEqual(
    frames.map(({ seq }) => seq),
    [1, 1, 2, 3, 4, 5],
  );
  session.receive({ type: "ack", id: dispatch.id, seq: 3 });
  frames.length = 0;
  session.receive(dispatch);
  assert.deepEqual(
    frames.map(({ seq }) => seq),
    [4, 5],
  );
  assert.equal(launches, 1);
  assert.deepEqual(journal.held(), [{ id: dispatch.id, last: 5, acknowledged: 3 }]);

  const outside = join(f.temporary, "outside");
  await mkdir(outside);
  const escaped = join(f.root, "escape");
  await symlink(outside, escaped);
  const unsafe = workerSession({
    device,
    root: f.root,
    dataDir: f.dataDir,
    worktrees: join(f.dataDir, "worktrees"),
    repositories: new Map([["project", escaped]]),
    journal,
    harnesses: { codex: async () => assert.fail("Harness reached an escaping workspace") },
    send(message) {
      if (message.type === "event") frames.push(message);
    },
    onStorageFailure: () => assert.fail("Could not write Worker journal"),
  });
  const unsafeId = randomUUID();
  unsafe.receive({ ...dispatch, id: unsafeId });
  await waitFor(async () =>
    frames.some(({ id, event }) => id === unsafeId && event.type === "execution.finished"),
  );
  const outcome = frames.at(-1)?.event;
  assert.equal(outcome?.type, "execution.finished");
  assert.match(outcome.reason ?? "", /resolves outside the configured root/);
});
