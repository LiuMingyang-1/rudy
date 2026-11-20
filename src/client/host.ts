import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import { defaultDataDir, parsePort } from "../host/connection.ts";
import { startHost } from "../host/local.ts";
import { nowledge } from "../partner/memory.ts";
import { loopback } from "../protocol/task.ts";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "data-dir": { type: "string" },
      workspace: { type: "string" },
      port: { type: "string" },
      "worker-port": { type: "string" },
      memory: { type: "boolean" },
      codex: { type: "string" },
      claude: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: npm run host -- [--workspace PATH] [--data-dir PATH] [--port PORT] [--worker-port PORT] [--codex PATH] [--claude PATH] [--memory]",
    );
    return;
  }

  const host = await startHost({
    workspaceRoot: values.workspace ?? process.env.RUDY_WORKSPACE ?? process.cwd(),
    dataDir: values["data-dir"] ?? defaultDataDir(),
    port: parsePort(values.port ?? process.env.RUDY_PORT),
    workerPort: values["worker-port"] === undefined ? undefined : parsePort(values["worker-port"]),
    codex: values.codex ?? process.env.RUDY_CODEX,
    claude: values.claude ?? process.env.RUDY_CLAUDE,
    partner: { config: loadConfig, memory: values.memory ? nowledge() : undefined },
  });
  const stop = () => {
    void host.close().catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  console.log(`Rudy Host listening on http://${loopback}:${host.port}`);
  if (host.workerPort !== undefined)
    console.log(
      `Worker endpoint is ws://${loopback}:${host.workerPort} (use an SSH tunnel or TLS proxy).`,
    );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
