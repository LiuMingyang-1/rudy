import { parseArgs } from "node:util";
import { defaultDataDir, parsePort } from "../host/connection.ts";
import { startHost } from "../host/local.ts";
import { loopback } from "../protocol/task.ts";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "data-dir": { type: "string" },
      workspace: { type: "string" },
      port: { type: "string" },
      codex: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: npm run host -- [--workspace PATH] [--data-dir PATH] [--port PORT] [--codex PATH]",
    );
    return;
  }

  const host = await startHost({
    workspaceRoot: values.workspace ?? process.env.RUDY_WORKSPACE ?? process.cwd(),
    dataDir: values["data-dir"] ?? defaultDataDir(),
    port: parsePort(values.port ?? process.env.RUDY_PORT),
    codex: values.codex ?? process.env.RUDY_CODEX,
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
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
