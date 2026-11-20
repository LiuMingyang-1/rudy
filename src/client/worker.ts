import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { Connection } from "../host/connection.ts";
import type { WorkerIdentity } from "../protocol/worker.ts";
import { pairWorker, startWorker } from "../worker/client.ts";
import { request } from "./orchestration-http.ts";

export const workerOptions = {
  device: { type: "string" },
  repository: { type: "string" },
  repo: { type: "string", multiple: true },
  codex: { type: "string" },
  claude: { type: "string" },
  name: { type: "string" },
} as const;

export const workerUsage = `  pair-code
  worker-pair URL                 Read the one-time code from stdin
  worker --repo NAME=PATH [--repo NAME=PATH] [--workspace ROOT] [--name NAME]
  devices
  revoke DEVICE_ID
  submit --repository NAME [--device DEVICE_ID|auto] --goal TEXT --completion TEXT`;

interface SavedWorker extends WorkerIdentity {
  address: string;
}

export async function workerCommand(
  command: string,
  id: string | undefined,
  dataDir: string,
  connect: () => Connection,
  options: { repo?: string[]; workspace?: string; name?: string; codex?: string; claude?: string },
): Promise<void> {
  const path = join(dataDir, "worker.json");
  if (command === "worker-pair") {
    if (!id) throw new Error("worker-pair requires a Worker endpoint URL.");
    let previous: SavedWorker | undefined;
    try {
      previous = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const code = readFileSync(0, "utf8").trim();
    const identity = await pairWorker(id, code, previous?.address === id ? previous : undefined);
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const temporary = `${path}.new`;
    writeFileSync(temporary, JSON.stringify({ ...identity, address: id }), {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, path);
    console.log(identity.device);
  } else if (command === "worker") {
    const saved = JSON.parse(readFileSync(path, "utf8")) as SavedWorker;
    const repositories = new Map<string, string>();
    for (const repo of options.repo ?? []) {
      const separator = repo.indexOf("=");
      if (separator <= 0 || separator === repo.length - 1)
        throw new Error("--repo requires NAME=PATH.");
      repositories.set(repo.slice(0, separator), repo.slice(separator + 1));
    }
    if (!repositories.size) throw new Error("worker requires at least one --repo NAME=PATH.");
    const worker = await startWorker({
      address: saved.address,
      identity: saved,
      dataDir,
      repositories,
      workspaceRoot: options.workspace ?? process.cwd(),
      name: options.name ?? hostname(),
      codex: options.codex,
      claude: options.claude,
    });
    const stop = () => {
      void worker.close();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await worker.done;
  } else {
    if (command === "revoke" && (!id || !/^[\w-]{1,128}$/.test(id)))
      throw new Error("revoke requires a device ID.");
    const path =
      command === "revoke"
        ? `/devices/${id}/revoke`
        : command === "pair-code"
          ? "/devices/pair"
          : "/devices";
    const result = await request(connect(), path, command === "devices" ? "GET" : "POST");
    if (command === "pair-code" && result && typeof result === "object" && "code" in result) {
      console.log(result.code);
    } else console.log(JSON.stringify(result, null, 2));
  }
}
