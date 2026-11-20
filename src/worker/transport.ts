import { createServer, type IncomingMessage } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";
import { serverPort } from "../host/events.ts";
import { object, RequestError, readBody } from "../host/requests.ts";
import { json } from "../host/routes.ts";
import { loopback } from "../protocol/task.ts";
import { workerPath } from "../protocol/worker.ts";
import type { Pairing } from "./pairing.ts";

const bearer = (request: IncomingMessage) => request.headers.authorization?.replace(/^Bearer /, "");

export async function listenWorker(
  port: number,
  pairing: Pairing,
  connect: (socket: WebSocket, device: string) => void,
) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const server = createServer({ requestTimeout: 15_000 }, (request, response) => {
    if (request.headers.origin || request.method !== "POST" || request.url !== "/pair") {
      json(response, 404, { error: "Worker route not found." });
      return;
    }
    void (async () => {
      try {
        const body = object(await readBody(request));
        const previous =
          typeof body.device === "string" && typeof body.token === "string"
            ? { device: body.device, token: body.token }
            : undefined;
        const identity = pairing.redeem(bearer(request) ?? "", previous);
        if (!identity) throw new RequestError(401, "Pairing refused.");
        json(response, 201, identity);
      } catch (error) {
        if (error instanceof RequestError) json(response, error.status, { error: error.message });
        else json(response, 503, { error: "Could not save worker pairing." });
      }
    })();
  });
  server.on("upgrade", (request, socket, head) => {
    const device =
      !request.headers.origin &&
      request.url === workerPath &&
      pairing.authenticate(bearer(request) ?? "");
    if (!device) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => connect(ws, device));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, loopback, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    port: serverPort(server),
    close() {
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      const done = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      return done;
    },
  };
}
