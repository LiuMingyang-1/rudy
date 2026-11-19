import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { defaultDataDir, readConnection } from "../host/connection.ts";
import { parseEventCursor, type Task } from "../protocol/task.ts";
import { history, request, tail } from "./orchestration-http.ts";

const usage = `Usage: npm run rudy -- COMMAND [--data-dir PATH]

  submit --goal TEXT --completion TEXT [--workspace PATH] [--scope TEXT] [--constraints TEXT] [--follow]
  list
  show TASK_ID
  events TASK_ID [--after SEQ]
  tail TASK_ID [--after SEQ]
  stop TASK_ID`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "data-dir": { type: "string" },
      goal: { type: "string" },
      completion: { type: "string" },
      scope: { type: "string" },
      constraints: { type: "string" },
      workspace: { type: "string" },
      follow: { type: "boolean" },
      after: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, taskId] = positionals;
  if (values.help || !command) {
    console.log(usage);
    return;
  }
  if (!["submit", "list", "show", "events", "tail", "stop"].includes(command)) {
    throw new Error(`Unknown command "${command}". Run with --help for usage.`);
  }
  if (positionals.length > 2 || ((command === "submit" || command === "list") && taskId)) {
    throw new Error("Unexpected arguments. Run with --help for usage.");
  }
  if (command === "submit" && (!values.goal || !values.completion)) {
    throw new Error("submit requires --goal and --completion.");
  }
  if (command !== "submit" && command !== "list" && (!taskId || !/^[\w-]{1,128}$/.test(taskId))) {
    throw new Error(`${command} requires a task ID.`);
  }

  const connection = readConnection(values["data-dir"] ?? defaultDataDir());
  if (command === "submit") {
    const task = (await request(connection, "/tasks", "POST", {
      goal: values.goal,
      completion: values.completion,
      workspace: resolve(values.workspace ?? process.cwd()),
      scope: values.scope,
      constraints: values.constraints,
    })) as Task;
    console.log(JSON.stringify(task));
    if (values.follow) await tail(connection, task.taskId, 0);
  } else if (command === "list") {
    console.log(JSON.stringify(await request(connection, "/tasks"), null, 2));
  } else if (command === "show") {
    console.log(JSON.stringify(await request(connection, `/tasks/${taskId}`), null, 2));
  } else if (command === "stop") {
    console.log(JSON.stringify(await request(connection, `/tasks/${taskId}/stop`, "POST")));
  } else {
    const after = parseEventCursor(values.after ?? "0");
    await (command === "tail" ? tail : history)(connection, taskId, after);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
