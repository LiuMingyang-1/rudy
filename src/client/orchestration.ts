import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { defaultDataDir, readConnection } from "../host/connection.ts";
import { parseEventCursor, type Task } from "../protocol/task.ts";
import {
  localTimes,
  orchestrationCommand,
  orchestrationOptions,
  orchestrationUsage,
  submission,
} from "./orchestration-commands.ts";
import { history, request, tail } from "./orchestration-http.ts";
import { workerCommand, workerOptions, workerUsage } from "./worker.ts";

const usage = `Usage: npm run rudy -- COMMAND [--data-dir PATH]

  delegate TEXT [--workspace PATH | --repository NAME [--device ID|auto]]
                [--base REF] [--recall QUERY]
  remember DECISION
  submit --goal TEXT --completion TEXT [--workspace PATH] [--scope TEXT] [--constraints TEXT]
         [--base REF] [--at DATE] [--harness codex|claude-code] [--follow]
  list
  show TASK_ID
  events TASK_ID [--after SEQ]
  tail TASK_ID [--after SEQ]
  stop TASK_ID
  pause TASK_ID
  resume TASK_ID
  switch TASK_ID --harness codex|claude-code
${orchestrationUsage}
${workerUsage}`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      ...orchestrationOptions,
      ...workerOptions,
      "data-dir": { type: "string" },
      goal: { type: "string" },
      completion: { type: "string" },
      scope: { type: "string" },
      constraints: { type: "string" },
      workspace: { type: "string" },
      recall: { type: "string" },
      follow: { type: "boolean" },
      after: { type: "string" },
      harness: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, taskId] = positionals;
  if (values.help || !command) {
    console.log(usage);
    return;
  }
  if (positionals.length > 2) throw new Error("Unexpected arguments. Run with --help for usage.");
  const dataDir = values["data-dir"] ?? defaultDataDir();
  const connect = () => readConnection(dataDir);
  if (command === "delegate" || command === "remember") {
    if (!taskId) throw new Error(`${command} requires text.`);
    const body =
      command === "remember"
        ? { decision: taskId }
        : {
            request: taskId,
            workspace: values.workspace
              ? resolve(values.workspace)
              : values.repository === undefined
                ? resolve(".")
                : undefined,
            repository: values.repository,
            device: values.device,
            baseline: values.base,
            recall: values.recall,
          };
    const result = await request(connect(), `/${command}`, "POST", body, 300_000);
    console.log(JSON.stringify(result, localTimes, 2));
    return;
  }
  if (["pair-code", "worker-pair", "worker", "devices", "revoke"].includes(command)) {
    await workerCommand(command, taskId, dataDir, connect, values);
    return;
  }
  if (
    ["group", "routine", "routines", "routine-pause", "routine-resume", "merge"].includes(command)
  ) {
    if (taskId && (command === "routine" || command === "routines"))
      throw new Error("Unexpected arguments. Run with --help for usage.");
    await orchestrationCommand(connect(), command, taskId, values);
    return;
  }
  if (
    !["submit", "list", "show", "events", "tail", "stop", "pause", "resume", "switch"].includes(
      command,
    )
  ) {
    throw new Error(`Unknown command "${command}". Run with --help for usage.`);
  }
  if ((command === "submit" || command === "list") && taskId) {
    throw new Error("Unexpected arguments. Run with --help for usage.");
  }
  if (command !== "submit" && command !== "list" && (!taskId || !/^[\w-]{1,128}$/.test(taskId))) {
    throw new Error(`${command} requires a task ID.`);
  }

  if (command === "switch" && values.harness !== "codex" && values.harness !== "claude-code") {
    throw new Error("switch requires --harness codex or --harness claude-code.");
  }

  const connection = connect();
  if (command === "submit") {
    const task = (await request(connection, "/tasks", "POST", submission(values))) as Task;
    console.log(JSON.stringify(task, localTimes));
    if (values.follow) await tail(connection, task.taskId, 0);
  } else if (command === "list") {
    console.log(JSON.stringify(await request(connection, "/tasks"), localTimes, 2));
  } else if (command === "show") {
    console.log(JSON.stringify(await request(connection, `/tasks/${taskId}`), localTimes, 2));
  } else if (
    command === "stop" ||
    command === "pause" ||
    command === "resume" ||
    command === "switch"
  ) {
    const action = command === "switch" ? `resume?harness=${values.harness}` : command;
    console.log(JSON.stringify(await request(connection, `/tasks/${taskId}/${action}`, "POST")));
  } else {
    const after = parseEventCursor(values.after ?? "0");
    await (command === "tail" ? tail : history)(connection, taskId, after);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
