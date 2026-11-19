import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { Task, TaskDetail, TaskEvent } from "../../src/protocol/task.ts";
import { cli, fixture, spawnHost, submit, waitFor } from "./fixture.ts";

test("CLI can disconnect mid-run and resume a paged event stream by seq", async (t) => {
  const f = await fixture(t);
  await spawnHost(f);
  const task: Task = JSON.parse((await submit(f, "gated many messages")).stdout);

  const follower = spawn(
    process.execPath,
    ["src/client/orchestration.ts", "tail", task.taskId, "--data-dir", f.dataDir],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const ended = new Promise((resolve) => follower.once("exit", resolve));
  f.cleanup.push(async () => {
    follower.kill();
    await ended;
  });
  let observed = "";
  follower.stdout.setEncoding("utf8").on("data", (chunk) => {
    observed += chunk;
  });
  await waitFor(async () => observed.includes('"message":"ready"}\n'));
  const first = events(observed);
  const lastSeq = first.at(-1)?.seq;
  assert.ok(lastSeq);
  follower.kill("SIGINT");
  await ended;

  const running: TaskDetail = JSON.parse((await cli(f, "show", task.taskId)).stdout);
  assert.equal(running.task.status, "running");
  assert.equal(running.executions[0].nativeSessionId, "native-fixture-thread");
  assert.notEqual(running.executions[0].executionId, task.taskId);

  const reconnect = cli(f, "tail", task.taskId, "--after", String(lastSeq));
  await writeFile(join(f.root, "release"), "");
  const rest = events((await reconnect).stdout);
  assert.equal(rest.filter((event) => event.type === "execution.progress").length, 117);
  assert.ok(rest.every((event) => event.seq > lastSeq));
  assert.ok(rest.every((event) => event.executionId === running.executions[0].executionId));

  const history = events((await cli(f, "events", task.taskId)).stdout);
  assert.deepEqual([...first, ...rest], history);
  assert.ok(history.every((event, index) => index === 0 || event.seq > history[index - 1].seq));
  assert.ok(!JSON.stringify(history).includes("raw tool output"));
  assert.deepEqual(
    events((await cli(f, "tail", task.taskId, "--after", String(history.at(-1)?.seq))).stdout),
    [],
  );

  const detail: TaskDetail = JSON.parse((await cli(f, "show", task.taskId)).stdout);
  assert.equal(detail.task.status, "succeeded");
  assert.equal(detail.executions[0].status, "succeeded");
  assert.match(detail.executions[0].result ?? "", /^done /);
  assert.equal(detail.executions[0].result?.length, 2049);
  assert.equal((await stat(join(f.dataDir, "tasks.sqlite"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.dataDir, "connection.json"))).mode & 0o777, 0o600);
});

test("follow command streams events and stop confirms process exit", async (t) => {
  const f = await fixture(t);
  await spawnHost(f);
  const followed = await cli(
    f,
    "submit",
    "--workspace",
    f.root,
    "--goal",
    "immediate",
    "--completion",
    "Report done.",
    "--follow",
  );
  assert.equal(events(followed.stdout).at(-1)?.type, "execution.finished");

  const task: Task = JSON.parse((await submit(f, "gated")).stdout);
  await waitFor(async () =>
    (await cli(f, "events", task.taskId)).stdout.includes('"message":"ready"'),
  );
  await cli(f, "stop", task.taskId);
  const terminal = events((await cli(f, "tail", task.taskId)).stdout).at(-1);
  assert.equal(terminal?.type, "execution.finished");
  assert.equal(terminal.type === "execution.finished" && terminal.status, "canceled");
});

function events(stdout: string): TaskEvent[] {
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
