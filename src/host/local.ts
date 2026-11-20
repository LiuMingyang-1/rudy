import { randomBytes } from "node:crypto";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../config.ts";
import type { PartnerOptions } from "../partner/partner.ts";
import { loopback } from "../protocol/task.ts";
import { LocalRunner } from "../runner/local.ts";
import { directory } from "../runner/workspace.ts";
import { claimHost, initSchema, openPrivateDatabase } from "../store/database.ts";
import { RoutineStore } from "../store/routines.ts";
import { reconcile } from "../store/tasks/journal.ts";
import { RemoteJournal } from "../store/tasks/remote.ts";
import { TaskStore } from "../store/tasks/store.ts";
import { Pairing } from "../worker/pairing.ts";
import { remoteRunner } from "../worker/remote/runner.ts";
import { listenWorker } from "../worker/transport.ts";
import { authorized, publishConnection } from "./connection.ts";
import { attachEvents, serverPort } from "./events.ts";
import { type Clock, orchestrate, systemClock } from "./orchestration.ts";
import { partnerRoutes } from "./partner.ts";
import { json, routes } from "./routes.ts";

export interface HostOptions {
  dataDir: string;
  workspaceRoot: string;
  port: number;
  codex?: string;
  claude?: string;
  clock?: Clock;
  workerPort?: number;
  partner?: PartnerOptions;
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
    reconcile(db);
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
  const worktrees = join(dataDir, "worktrees");
  mkdirSync(worktrees, { recursive: true, mode: 0o700 });
  if (realpathSync(worktrees) !== worktrees) throw new Error("Managed worktree directory changed.");
  const clock = options.clock ?? systemClock;
  const token = randomBytes(32).toString("hex");
  const pairing = new Pairing(db, () => clock.now());
  const remote = remoteRunner(
    store,
    new RemoteJournal(db),
    pairing,
    clock,
    () => {
      events.notify();
      queueMicrotask(() => runner.dispatch());
    },
    () => runner.storageFailed(),
  );
  const runner = new LocalRunner(
    store,
    root,
    {
      codex: options.codex ?? "codex",
      "claude-code": options.claude ?? "claude",
    },
    () => events.notify(),
    worktrees,
    () => clock.now(),
    remote,
  );
  const orchestration = orchestrate(
    store,
    runner,
    new RoutineStore(db, worktrees),
    { root, dataDir, worktrees },
    clock,
    () => events.notify(),
    remote,
    options.workerPort === undefined ? undefined : pairing,
  );
  const partner = partnerRoutes(
    store,
    orchestration,
    root,
    dataDir,
    options.partner ?? { config: loadConfig },
  );
  const route = routes(store, runner, orchestration, partner);
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
  let workers: Awaited<ReturnType<typeof listenWorker>> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, loopback, () => {
        server.off("error", reject);
        resolve();
      });
    });
    if (options.workerPort !== undefined)
      workers = await listenWorker(options.workerPort, pairing, remote.connect);
    publishConnection(dataDir, serverPort(server), token);
  } catch (error) {
    events.close();
    await workers?.close();
    server.close();
    throw error;
  }
  orchestration.tick();
  const stopTick = clock.subscribe(() => {
    try {
      remote.tick();
      orchestration.tick();
    } catch {
      runner.storageFailed();
    }
  });

  let closing: Promise<void> | undefined;
  return {
    port: serverPort(server),
    workerPort: workers?.port,
    close() {
      closing ??= close();
      return closing;
    },
  };

  async function close(): Promise<void> {
    stopTick();
    events.close();
    const drained = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    const stopped = runner.close();
    remote.close();
    try {
      await Promise.all([workers?.close(), stopped, drained.then(partner.idle)]);
      rmSync(join(dataDir, "connection.json"), { force: true });
    } finally {
      db.close();
      lock.close();
    }
  }
}
