import { accessSync, constants, mkdirSync, realpathSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { WebSocket } from "ws";
import { claude } from "../harness/claude.ts";
import { codex } from "../harness/codex.ts";
import type { RunHarness } from "../harness/process.ts";
import type { Harness } from "../protocol/task.ts";
import {
  type HostMessage,
  type WorkerIdentity,
  workerName,
  workerPath,
} from "../protocol/worker.ts";
import { contains, directory, validateWorkspace } from "../runner/workspace.ts";
import { claimHost, openPrivateDatabase } from "../store/database.ts";
import { WorkerJournal } from "./journal.ts";
import { workerSession } from "./session.ts";

export function workerEndpoint(address: string): URL {
  const url = new URL(address);
  if (
    (url.protocol !== "wss:" &&
      (url.protocol !== "ws:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("Use a wss:// address or a loopback ws:// address through a tunnel.");
  }
  return url;
}

export async function pairWorker(address: string, code: string, previous?: WorkerIdentity) {
  const url = workerEndpoint(address);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/pair";
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${code}`, "content-type": "application/json" },
    body: JSON.stringify(previous ?? {}),
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("Worker pairing was refused.");
  return (await response.json()) as WorkerIdentity;
}

function available(executable: string): boolean {
  const candidates = executable.includes("/")
    ? [executable]
    : (process.env.PATH ?? "").split(delimiter).map((path) => join(path, executable));
  return candidates.some((path) => {
    try {
      accessSync(path, constants.X_OK);
      return statSync(path).isFile();
    } catch {
      return false;
    }
  });
}

export async function startWorker(options: {
  address: string;
  identity: WorkerIdentity;
  name: string;
  dataDir: string;
  workspaceRoot: string;
  repositories: ReadonlyMap<string, string>;
  codex?: string;
  claude?: string;
  reconnectMs?: number;
}) {
  const url = workerEndpoint(options.address);
  url.pathname = workerPath;
  const root = await directory(options.workspaceRoot);
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  const dataDir = realpathSync(options.dataDir);
  const repositories = new Map<string, string>();
  for (const [name, path] of options.repositories) {
    const repository = await validateWorkspace(root, path);
    if (!workerName.test(name) || contains(repository, dataDir) || contains(dataDir, repository))
      throw new Error(
        "Repository alias is invalid or its path overlaps the Worker data directory.",
      );
    repositories.set(name, repository);
  }
  const worktrees = join(dataDir, "worktrees");
  mkdirSync(worktrees, { recursive: true, mode: 0o700 });
  if (realpathSync(worktrees) !== worktrees) throw new Error("Managed worktree directory changed.");
  const harnesses: Partial<Record<Harness, RunHarness>> = {};
  const executable = options.codex ?? "codex";
  const reviewer = options.claude ?? "claude";
  if (available(executable))
    harnesses.codex = codex(executable.includes("/") ? resolve(executable) : executable);
  if (available(reviewer))
    harnesses["claude-code"] = claude(reviewer.includes("/") ? resolve(reviewer) : reviewer);
  const capabilities = {
    name: options.name,
    repositories: [...repositories.keys()],
    harnesses: (["codex", "claude-code"] as const).filter((harness) => harnesses[harness]),
  };
  const { device, token } = options.identity;
  const lock = claimHost(dataDir);
  let db: ReturnType<typeof openPrivateDatabase>;
  let journal: WorkerJournal;
  try {
    db = openPrivateDatabase(join(dataDir, "worker.sqlite"));
    try {
      journal = new WorkerJournal(db, device);
    } catch (error) {
      db.close();
      throw error;
    }
  } catch (error) {
    lock.close();
    throw error;
  }
  let socket: WebSocket | undefined;
  let retry: NodeJS.Timeout | undefined;
  let stopping: Promise<void> | undefined;
  const session = workerSession({
    device,
    root,
    dataDir,
    worktrees,
    repositories,
    harnesses,
    journal,
    onStorageFailure: () => {
      void close();
    },
    send(message) {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    },
  });
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });

  function connect(): void {
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${token}` },
      handshakeTimeout: 5000,
      maxPayload: 1024 * 1024,
    });
    socket = ws;
    const heartbeat = setTimeout(() => ws.terminate(), 15_000);
    ws.once("open", () => {
      try {
        ws.send(JSON.stringify({ type: "hello", device, capabilities, held: session.held() }));
        session.replay();
      } catch {
        void close();
      }
    });
    ws.on("ping", () => heartbeat.refresh());
    ws.on("message", (raw) => {
      if (stopping) return;
      try {
        session.receive(JSON.parse(raw.toString()) as HostMessage);
      } catch {
        void close();
      }
    });
    ws.on("error", () => ws.terminate());
    ws.once("unexpected-response", (_request, response) => {
      response.resume();
      if (response.statusCode === 401) void close();
      else ws.terminate();
    });
    ws.once("close", () => {
      clearTimeout(heartbeat);
      if (!stopping) retry = setTimeout(connect, options.reconnectMs ?? 1000);
    });
  }

  function close(): Promise<void> {
    stopping ??= Promise.resolve().then(async () => {
      clearTimeout(retry);
      socket?.terminate();
      try {
        await session.stop();
      } finally {
        db.close();
        lock.close();
        finish();
      }
    });
    return stopping;
  }

  connect();
  return { close, done, disconnect: () => socket?.terminate() };
}
