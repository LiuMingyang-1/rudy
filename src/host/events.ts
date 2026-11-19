import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { eventProtocol, loopback, parseEventCursor } from "../protocol/task.ts";
import type { TaskStore } from "../store/tasks.ts";
import { authorized } from "./connection.ts";
import { taskRoute } from "./routes.ts";

export function attachEvents(server: Server, store: TaskStore, token: string) {
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 1024,
    handleProtocols: () => eventProtocol,
  });
  const pumps = new Set<() => void>();

  server.on("upgrade", (request, socket, head) => {
    if (request.headers.origin || request.headers.host !== `${loopback}:${serverPort(server)}`) {
      socket.destroy();
      return;
    }
    const protocols = request.headers["sec-websocket-protocol"]?.split(",").map((p) => p.trim());
    if (
      protocols?.length !== 2 ||
      protocols[0] !== eventProtocol ||
      !authorized(token, protocols[1])
    ) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }

    let after: number;
    let taskId: string;
    try {
      const url = new URL(request.url ?? "/", `http://${loopback}`);
      const match = taskRoute.exec(url.pathname);
      if (match?.[2] !== "events" || !store.get(match[1])) {
        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        return;
      }
      taskId = match[1];
      after = parseEventCursor(url.searchParams.get("after") ?? "0");
    } catch {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }

    sockets.handleUpgrade(request, socket, head, (ws) => {
      let sending = false;
      let caughtUp = false;
      ws.on("error", () => ws.terminate());
      ws.on("message", () => ws.close(1008, "Event stream is read-only."));
      ws.on("close", () => pumps.delete(pump));
      pumps.add(pump);
      pump();

      function pump(): void {
        if (sending || ws.readyState !== WebSocket.OPEN) return;
        try {
          const batch = store.events(taskId, after);
          const last = batch.at(-1);
          if (last) {
            after = last.seq;
            send(batch);
          } else if (!caughtUp) {
            caughtUp = true;
            send([{ type: "stream.caught_up", status: store.get(taskId)?.status }]);
          }
        } catch {
          ws.close(1011, "Could not read the stored event stream.");
        }
      }

      function send(messages: unknown[]): void {
        sending = true;
        ws.send(JSON.stringify(messages), (error) => {
          sending = false;
          if (error) ws.terminate();
          else pump();
        });
      }
    });
  });

  return {
    notify() {
      for (const pump of pumps) pump();
    },
    close() {
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
    },
  };
}

export function serverPort(server: Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Host is not listening.");
  return address.port;
}
