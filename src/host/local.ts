import { randomBytes } from "node:crypto";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { loopback } from "../protocol/task.ts";
import { LocalRunner } from "../runner/local.ts";
import { directory } from "../runner/workspace.ts";
import { claimHost, initSchema, openPrivateDatabase } from "../store/database.ts";
import { TaskStore } from "../store/tasks.ts";
import { authorized, publishConnection } from "./connection.ts";
import { attachEvents, serverPort } from "./events.ts";
import { json, routes } from "./routes.ts";

export interface HostOptions {
  dataDir: string;
  workspaceRoot: string;
  port: number;
  codex?: string;
}

export async function startHost(options: HostOptions) {
  const root = await directory(options.workspaceRoot);
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  const dataDir = realpathSync(options.dataDir);
  const lock = claimHost(dataDir);
  let db: DatabaseSync | undefined;
  try {
    db = openPrivateDatabase(join(dataDir, "tasks.sqlite"));
    initSchema(db);
    const store = new TaskStore(db);
    store.reconcile();
    return await listen(options, root, dataDir, store, db, lock);
  } catch (error) {
    db?.close();
    lock.close();
    throw error;
  }
}

async function listen(
  options: HostOptions,
  root: string,
  dataDir: string,
  store: TaskStore,
  db: DatabaseSync,
  lock: DatabaseSync,
) {
  const token = randomBytes(32).toString("hex");
  const runner = new LocalRunner(store, root, options.codex ?? "codex", () => events.notify());
  const route = routes(store, runner, root, dataDir);
  const server = createServer({ requestTimeout: 15_000 }, (request, response) => {
    if (
      request.headers.origin ||
      request.headers.host !== `${loopback}:${serverPort(server)}` ||
      !authorized(token, request.headers.authorization?.replace(/^Bearer /, ""))
    ) {
      json(response, 401, { error: "Connect using the local Rudy Host connection file." });
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? "/", `http://${loopback}`);
    } catch {
      json(response, 400, { error: "Invalid request URL." });
      return;
    }
    void route(request, response, url);
  });
  const events = attachEvents(server, store, token);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, loopback, () => {
        server.off("error", reject);
        resolve();
      });
    });
    publishConnection(dataDir, serverPort(server), token);
  } catch (error) {
    events.close();
    server.close();
    throw error;
  }
  runner.dispatch();

  let closing: Promise<void> | undefined;
  return {
    port: serverPort(server),
    close() {
      closing ??= close();
      return closing;
    },
  };

  async function close(): Promise<void> {
    events.close();
    const drained = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await runner.close();
    await drained;
    try {
      rmSync(join(dataDir, "connection.json"), { force: true });
    } finally {
      db.close();
      lock.close();
    }
  }
}
