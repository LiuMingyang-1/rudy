import type { Connection } from "../host/connection.ts";
import { eventPageSize, eventPath, eventProtocol, loopback } from "../protocol/task.ts";

export async function request(
  connection: Connection,
  path: string,
  method = "GET",
  data?: unknown,
  timeout = 10_000,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`http://${loopback}:${connection.port}${path}`, {
      method,
      headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data),
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    throw new Error("Could not connect to the local Rudy Host. Start it with npm run host.");
  }
  const value: unknown = await response.json();
  if (!response.ok) {
    throw new Error(
      value && typeof value === "object" && "error" in value && typeof value.error === "string"
        ? value.error
        : `Host returned HTTP ${response.status}.`,
    );
  }
  return value;
}

export async function history(
  connection: Connection,
  taskId: string,
  cursor: number,
): Promise<void> {
  while (true) {
    const batch = await request(connection, eventPath(taskId, cursor));
    if (!Array.isArray(batch)) throw new Error("Invalid event history from Host.");
    let next = cursor;
    for (const event of batch) {
      if (!event || typeof event.seq !== "number" || event.seq <= next) {
        throw new Error("Invalid event sequence from Host.");
      }
      next = event.seq;
      console.log(JSON.stringify(event));
    }
    if (batch.length < eventPageSize) return;
    cursor = next;
  }
}

export function tail(connection: Connection, taskId: string, cursor: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `ws://${loopback}:${connection.port}${eventPath(taskId, cursor)}`,
      [eventProtocol, connection.token],
    );

    let caughtUp = false;
    let finished = false;
    socket.addEventListener("message", (message) => {
      const batch: unknown = JSON.parse(String(message.data));
      if (!Array.isArray(batch)) {
        reject(new Error("Invalid event stream from Host."));
        socket.close();
        return;
      }
      for (const event of batch) {
        if (event.type === "stream.caught_up") {
          caughtUp = true;
          finished = event.status !== "running" && event.status !== "queued";
        } else {
          console.log(JSON.stringify(event));
          finished =
            caughtUp &&
            (event.type === "execution.finished" ||
              event.type === "task.waiting" ||
              event.type === "task.canceled");
        }
      }
      if (finished) {
        socket.close();
        resolve();
      }
    });
    socket.addEventListener("close", () => {
      if (!finished)
        reject(new Error("Event stream closed. Reconnect with tail and the last seq."));
    });
    socket.addEventListener("error", () => {
      reject(new Error("Could not open event stream. Check the Host and task ID."));
    });
  });
}
