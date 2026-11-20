import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { HostMessage, WorkerMessage } from "../../protocol/worker.ts";

type Request =
  | Omit<Extract<HostMessage, { type: "baseline" }>, "id">
  | Omit<Extract<HostMessage, { type: "merge" }>, "id">;

interface Pending {
  type: Request["type"];
  expires: number;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

export class RemoteRequests {
  private readonly pending = new Map<string, Pending>();

  get merging(): boolean {
    return [...this.pending.values()].some(({ type }) => type === "merge");
  }

  send(socket: WebSocket, request: Request, now: number): Promise<string> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { type: request.type, expires: now + 8000, resolve, reject });
      socket.send(JSON.stringify({ ...request, id }));
    });
  }

  reply({ id, value, error }: Extract<WorkerMessage, { type: "reply" }>): void {
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    if (value !== undefined) request.resolve(value);
    else request.reject(new Error(error ?? "The Worker request failed."));
  }

  expire(now: number): boolean {
    let expired = false;
    for (const [id, { expires, reject, type }] of this.pending) {
      if (now < expires) continue;
      this.pending.delete(id);
      reject(
        new Error(
          type === "merge"
            ? "Merge confirmation was lost. Check the target branch."
            : "The Worker did not resolve the baseline in time.",
        ),
      );
      expired = true;
    }
    return expired;
  }

  disconnect(): void {
    for (const { reject, type } of this.pending.values())
      reject(
        new Error(
          type === "merge"
            ? "Device disconnected during merge. Check the target branch."
            : "Execution device disconnected.",
        ),
      );
    this.pending.clear();
  }
}
