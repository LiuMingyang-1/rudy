import type { WebSocket } from "ws";
import type { Clock } from "../../host/orchestration.ts";
import { type Capabilities, type WorkerMessage, waitingDevice } from "../../protocol/worker.ts";
import type { RemoteJournal } from "../../store/tasks/remote.ts";

export const unknown = `${waitingDevice} Previous execution state is unknown.`;
const gap = `${waitingDevice} Worker event history has a gap.`;

export interface Peer {
  socket: WebSocket;
  device: string;
  capabilities?: Capabilities;
  seen: number;
  held: Set<string>;
}

export function attachPeer(
  peer: Peer,
  options: {
    clock: Clock;
    journal: RemoteJournal;
    wake: () => void;
    fail: () => void;
    current: () => boolean;
    close: () => void;
    ready: () => void;
    reply: (message: Extract<WorkerMessage, { type: "reply" }>) => void;
  },
) {
  const { socket, device } = peer;
  const { clock, journal, wake } = options;
  socket.on("pong", () => {
    peer.seen = clock.now();
  });
  socket.on("error", () => socket.terminate());
  socket.on("close", options.close);
  socket.on("message", (raw) => {
    if (!options.current()) return;
    let message: WorkerMessage;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      socket.close(1008, "Invalid Worker message.");
      return;
    }
    try {
      if (message.type === "hello" && !peer.capabilities && message.device === device) {
        peer.capabilities = message.capabilities;
        options.ready();
        const reported = new Map(message.held.map((entry) => [entry.id, entry]));
        peer.held = new Set(reported.keys());
        for (const execution of journal.open()) {
          const held = execution.device === device && reported.get(execution.executionId);
          const reason = !held
            ? unknown
            : execution.remoteSeq < held.acknowledged || execution.remoteSeq > held.last
              ? gap
              : null;
          if (reason) peer.held.delete(execution.executionId);
          journal.presence(execution, reason);
        }
        wake();
      } else if (message.type === "event" && peer.capabilities && peer.held.has(message.id)) {
        const seq = journal.event(device, message);
        if (seq !== undefined) socket.send(JSON.stringify({ type: "ack", id: message.id, seq }));
        else {
          const execution = journal.open().find(({ executionId }) => executionId === message.id);
          if (execution) {
            journal.presence(execution, gap);
            peer.held.delete(message.id);
          }
        }
        wake();
      } else if (message.type === "reply" && peer.capabilities) {
        options.reply(message);
        wake();
      }
    } catch {
      options.fail();
    }
  });
}
