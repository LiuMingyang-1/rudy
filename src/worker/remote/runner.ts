import type { WebSocket } from "ws";
import type { Clock } from "../../host/orchestration.ts";
import type { MergeConfirmation } from "../../protocol/orchestration.ts";
import type { Task } from "../../protocol/task.ts";
import { type ExecutionInput, type HostMessage, reconnecting } from "../../protocol/worker.ts";
import type { RemoteJournal } from "../../store/tasks/remote.ts";
import type { TaskStore } from "../../store/tasks/store.ts";
import type { Pairing } from "../pairing.ts";
import { attachPeer, type Peer, unknown } from "./connection.ts";
import { RemoteRequests } from "./requests.ts";

export const offline = "Waiting for device to accept the task.";

export function remoteRunner(
  store: TaskStore,
  journal: RemoteJournal,
  pairing: Pairing,
  clock: Clock,
  wake: () => void,
  storageFailed: () => void,
) {
  let peer: Peer | undefined;
  let deadline: number | undefined;
  let closing = false;
  let failed = false;
  const requests = new RemoteRequests();
  const send = (to: Peer, message: HostMessage) => to.socket.send(JSON.stringify(message));
  const markOffline = (reason: string) => {
    for (const execution of journal.open()) journal.presence(execution, reason);
  };
  markOffline(unknown);

  function fail(): void {
    failed = true;
    peer?.socket.terminate();
    storageFailed();
  }

  function disconnected(from: Peer): void {
    if (peer !== from) return;
    peer = undefined;
    requests.disconnect();
    if (closing || failed) return;
    deadline = clock.now() + 15_000;
    try {
      for (const execution of journal.open()) {
        if (execution.status === "running") journal.presence(execution, reconnecting);
      }
      wake();
    } catch {
      fail();
    }
  }

  return {
    storageFailed() {
      failed = true;
      peer?.socket.terminate();
    },
    connect(socket: WebSocket, device: string) {
      if (closing || failed || peer) return socket.close(1008, "Worker connection unavailable.");
      const from: Peer = { socket, device, seen: clock.now(), held: new Set() };
      peer = from;
      attachPeer(from, {
        clock,
        journal,
        wake,
        fail,
        current: () => peer === from && !failed,
        close: () => disconnected(from),
        ready: () => {
          deadline = undefined;
        },
        reply: (message) => requests.reply(message),
      });
    },
    devices() {
      const device = pairing.device();
      return device ? [{ device, online: Boolean(peer?.capabilities), ...peer?.capabilities }] : [];
    },
    revoke(device: string) {
      if (!pairing.revoke(device)) return false;
      if (peer) {
        const socket = peer.socket;
        peer = undefined;
        requests.disconnect();
        socket.close(1008, "Device revoked.");
      }
      markOffline(unknown);
      wake();
      return true;
    },
    tick() {
      const now = clock.now();
      if (requests.expire(now)) wake();
      if (peer && now - peer.seen >= 10_000) peer.socket.terminate();
      else peer?.socket.ping();
      if (deadline !== undefined && now >= deadline) {
        deadline = undefined;
        for (const execution of journal.open()) {
          if (execution.reason === reconnecting) journal.presence(execution, unknown);
        }
        wake();
      }
    },
    supports(task: NonNullable<Task["remote"]>, harness: Task["harness"]) {
      return (
        peer?.device === task.device &&
        peer.capabilities?.repositories.includes(task.repository) &&
        peer.capabilities.harnesses.includes(harness)
      );
    },
    dispatch(task: Task, upstream: ExecutionInput["upstream"]) {
      if (failed || requests.merging || journal.open().length) return;
      const to = peer;
      const remote = task.remote;
      if (
        !remote ||
        to?.device !== remote.device ||
        !to.capabilities?.repositories.includes(remote.repository) ||
        !to.capabilities.harnesses.includes(task.harness)
      ) {
        if (task.reason !== offline) {
          store.wait(task.taskId, offline);
          wake();
        }
        return;
      }
      const history = store.executions(task.taskId);
      const checkpoint = store.checkpoint(task.taskId);
      const execution = store.claim(task);
      to.held.add(execution.executionId);
      const git = task.review && task.after ? store.get(task.after)?.git : task.git;
      send(to, {
        type: "dispatch",
        id: execution.executionId,
        input: { task: { ...task, git }, history, checkpoint, upstream },
      });
      wake();
    },
    stop(task: Task, pause: boolean) {
      const to = peer;
      const execution = store.executions(task.taskId).at(-1);
      if (
        !execution ||
        !to ||
        to.device !== execution.device ||
        execution.endedAt ||
        !to.held.has(execution.executionId)
      )
        return false;
      send(to, { type: "stop", id: execution.executionId, pause });
      return true;
    },
    baseline(device: string, repository: string, ref: string) {
      const to = peer;
      if (!to?.capabilities || to.device !== device)
        throw new Error("The execution device is offline.");
      return requests.send(to.socket, { type: "baseline", repository, ref }, clock.now());
    },
    merge(task: Task, confirmation: MergeConfirmation) {
      const to = peer;
      if (
        !to?.capabilities ||
        to.device !== task.remote?.device ||
        requests.merging ||
        journal.open().length
      )
        throw new Error("The execution device must be online and idle to merge.");
      return requests.send(to.socket, { type: "merge", task, confirmation }, clock.now());
    },
    close() {
      closing = true;
      requests.disconnect();
    },
  };
}

export type RemoteRunner = ReturnType<typeof remoteRunner>;
