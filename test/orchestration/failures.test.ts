import assert from "node:assert/strict";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { request } from "../../src/client/orchestration-http.ts";
import { readConnection } from "../../src/host/connection.ts";
import { startHost } from "../../src/host/local.ts";
import type { Task, TaskDetail } from "../../src/protocol/task.ts";
import { initSchema } from "../../src/store/database.ts";
import { TaskStore } from "../../src/store/tasks.ts";
import { cli, fixture, ready, spawnHost, submit, waitFor } from "./fixture.ts";

test("missing executable and early exits persist failed task and execution together", async (t) => {
  for (const [goal, expected] of [
    ["missing executable", /Could not start Codex.*ENOENT/],
    ["invalid args", /exit 2.*unexpected argument/],
    ["silent exit", /exit 0.*No completed Codex session/],
  ] as const) {
    await t.test(goal, async (ctx) => {
      const f = await fixture(ctx);
      const host = await startHost({
        dataDir: f.dataDir,
        workspaceRoot: f.root,
        port: 0,
        codex: goal === "missing executable" ? join(f.temporary, "missing") : f.codex,
      });
      f.cleanup.push(() => host.close());
      const task: Task = JSON.parse((await submit(f, goal)).stdout);
      const stream = (await cli(f, "tail", task.taskId)).stdout;
      assert.match(stream, expected);
      const current: TaskDetail = JSON.parse((await cli(f, "show", task.taskId)).stdout);
      assert.equal(current.task.status, "failed");
      assert.equal(current.executions[0].status, "failed");
      assert.equal(current.executions[0].reason, current.task.reason);
      assert.match(current.task.reason ?? "", expected);
    });
  }
});

test("restart preserves results and marks crash-orphaned runs as unconfirmed", async (t) => {
  const f = await fixture(t);
  const first = await spawnHost(f);
  const done: Task = JSON.parse((await submit(f, "finish")).stdout);
  await cli(f, "tail", done.taskId);
  const previous = await cli(f, "show", done.taskId);
  const history = await cli(f, "events", done.taskId);

  const orphan: Task = JSON.parse((await submit(f, "gated")).stdout);
  await waitFor(() => ready(first.connection, orphan.taskId));
  await assert.rejects(
    startHost({
      dataDir: f.dataDir,
      workspaceRoot: f.root,
      port: 0,
      codex: f.codex,
    }),
    /Cannot claim the data directory/,
  );
  const active: TaskDetail = JSON.parse((await cli(f, "show", orphan.taskId)).stdout);

  await first.crash();
  await spawnHost(f);
  await writeFile(join(f.root, "release"), "");
  assert.equal((await cli(f, "show", done.taskId)).stdout, previous.stdout);
  assert.equal((await cli(f, "events", done.taskId)).stdout, history.stdout);
  assert.match((await cli(f, "list")).stdout, new RegExp(orphan.taskId));

  const recovered: TaskDetail = JSON.parse((await cli(f, "show", orphan.taskId)).stdout);
  assert.equal(recovered.task.status, "waiting");
  assert.equal(recovered.executions[0].status, "waiting");
  assert.equal(recovered.executions[0].executionId, active.executions[0].executionId);
  assert.equal(recovered.executions[0].nativeSessionId, active.executions[0].nativeSessionId);
  assert.equal(recovered.executions[0].endedAt, null);
  assert.match((await cli(f, "tail", orphan.taskId)).stdout, /Host restarted before confirming/);

  const blocked: Task = JSON.parse((await submit(f, "overlap")).stdout);
  assert.match(
    (await cli(f, "tail", blocked.taskId)).stdout,
    /Workspace overlaps unconfirmed execution/,
  );
});

test("Host validates canonical workspace and requires local authentication", async (t) => {
  const f = await fixture(t);
  const outside = join(f.temporary, "outside");
  const inside = join(f.root, "inside");
  await mkdir(outside);
  await mkdir(inside);
  await symlink(outside, join(f.root, "escape"));
  await symlink(inside, join(f.root, "alias"));
  const host = await startHost({
    dataDir: f.dataDir,
    workspaceRoot: f.root,
    port: 0,
    codex: f.codex,
  });
  f.cleanup.push(() => host.close());
  const connection = readConnection(f.dataDir);
  async function create(workspace: string) {
    return request(connection, "/tasks", "POST", {
      goal: "test",
      completion: "test done",
      workspace,
    });
  }
  await assert.rejects(create("../outside"), /outside the configured root/);
  await assert.rejects(create("escape"), /resolves outside/);
  await assert.rejects(create("missing"), /ENOENT/);
  assert.deepEqual(await request(connection, "/tasks"), []);
  const task = (await create("alias")) as Task;
  assert.equal(task.brief.workspace, await realpath(inside));
  const unauthorized = await fetch(`http://127.0.0.1:${host.port}/tasks`);
  assert.equal(unauthorized.status, 401);
  await unauthorized.text();
});

test("an event insert failure rolls back task and execution state", () => {
  using db = new DatabaseSync(":memory:");
  initSchema(db);
  const store = new TaskStore(db);
  const task = store.create({ goal: "atomicity", workspace: "/tmp", completion: "write event" });
  const execution = store.claim(task);
  db.exec(`
    CREATE TRIGGER fail_event BEFORE INSERT ON events
    BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;
  `);
  assert.throws(() => store.finish(execution, "failed", "test", null), /injected write failure/);
  assert.equal(store.get(task.taskId)?.status, "running");
  assert.equal(store.executions(task.taskId)[0].status, "running");
  assert.deepEqual(
    store.events(task.taskId, 0).map(({ type }) => type),
    ["task.queued", "execution.started"],
  );
});
