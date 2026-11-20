import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { WebSocket } from "ws";
import { startHost } from "../../src/host/local.ts";
import type { Task } from "../../src/protocol/task.ts";
import type { HostMessage, WorkerIdentity, WorkerMessage } from "../../src/protocol/worker.ts";
import { pairWorker, startWorker } from "../../src/worker/client.ts";
import { day3, fakeClock } from "./day3-fixture.ts";
import { cli, waitFor } from "./fixture.ts";

export async function day4(t: TestContext) {
  const d = await day3(t);
  const { f } = d;
  const clock = fakeClock();
  const hostRoot = join(f.temporary, "host-workspace");
  const workerData = join(f.temporary, "worker-data");
  await mkdir(hostRoot);
  const open = async (workerPort = 0) => {
    const host = await startHost({
      dataDir: f.dataDir,
      workspaceRoot: hostRoot,
      port: 0,
      workerPort,
      clock,
    });
    f.cleanup.push(host.close);
    return host;
  };
  const host = await open();
  const address = `ws://127.0.0.1:${host.workerPort}`;
  const code = (await cli(f, "pair-code")).stdout.trim();
  const identity = await pairWorker(address, code);
  const worker = async () => {
    const worker = await startWorker({
      address,
      identity,
      dataDir: workerData,
      workspaceRoot: f.root,
      name: "fixture-worker",
      repositories: new Map([["project", f.root]]),
      codex: f.codex,
      claude: join(f.temporary, "fake-review"),
      reconnectMs: 150,
    });
    f.cleanup.push(worker.close);
    await online();
    return worker;
  };
  const online = () =>
    waitFor(async () => {
      const devices = (await d.api("/devices")) as { online: boolean }[];
      return devices[0]?.online === true;
    });
  const plan = (goal: string) => ({ goal, completion: "Report the result", repository: "project" });
  const submit = async (goal: string) => (await d.api("/tasks", "POST", plan(goal))) as Task;
  return {
    ...d,
    host,
    address,
    identity,
    code,
    hostRoot,
    workerData,
    open,
    online,
    worker,
    plan,
    submit,
    clock,
  };
}

type Held = Extract<WorkerMessage, { type: "hello" }>["held"];

export async function fakePeer(address: string, identity: WorkerIdentity, held: Held = []) {
  const socket = new WebSocket(`${address}/worker`, {
    headers: { authorization: `Bearer ${identity.token}` },
  });
  const received: HostMessage[] = [];
  socket.on("message", (raw) => received.push(JSON.parse(raw.toString())));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.on("error", reject);
  });
  const send = (message: WorkerMessage) => socket.send(JSON.stringify(message));
  send({
    type: "hello",
    device: identity.device,
    capabilities: { name: "test-peer", repositories: ["project"], harnesses: ["codex"] },
    held,
  });
  const disconnect = () => socket.terminate();
  const dispatch = async (task: Task) => {
    await waitFor(async () =>
      received.some(
        (message) => message.type === "dispatch" && message.input.task.taskId === task.taskId,
      ),
    );
    const frame = received.find(
      (message) => message.type === "dispatch" && message.input.task.taskId === task.taskId,
    );
    assert.equal(frame?.type, "dispatch");
    return frame;
  };
  return { send, received, dispatch, disconnect };
}
