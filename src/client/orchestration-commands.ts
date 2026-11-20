import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Connection } from "../host/connection.ts";
import { request } from "./orchestration-http.ts";

export const orchestrationOptions = {
  base: { type: "string" },
  at: { type: "string" },
  every: { type: "string" },
  commit: { type: "string" },
  target: { type: "string" },
  "target-head": { type: "string" },
} as const;

export const orchestrationUsage = `  group FILE                     Submit a JSON object with a serial tasks array
                                 Writers use goal, completion, workspace and baseline.
                                 Reviewers use goal, completion, review: true and optional harness.
  routine --every MS --goal TEXT --completion TEXT [--workspace PATH] [--base REF]
  routines
  routine-pause ROUTINE_ID
  routine-resume ROUTINE_ID
  merge TASK_ID --commit SHA --target BRANCH --target-head SHA`;

export function submission(values: {
  goal?: string;
  completion?: string;
  workspace?: string;
  repository?: string;
  device?: string;
  scope?: string;
  constraints?: string;
  harness?: string;
  base?: string;
  at?: string;
}) {
  if (!values.goal || !values.completion)
    throw new Error("Task submission requires --goal and --completion.");
  const waitUntil = values.at === undefined ? undefined : Date.parse(values.at);
  if (waitUntil !== undefined && !Number.isFinite(waitUntil))
    throw new Error("--at requires a valid date and time.");
  return {
    goal: values.goal,
    completion: values.completion,
    workspace:
      values.repository === undefined || values.workspace !== undefined
        ? resolve(values.workspace ?? process.cwd())
        : undefined,
    repository: values.repository,
    device: values.device,
    scope: values.scope,
    constraints: values.constraints,
    harness: values.harness,
    baseline: values.base,
    waitUntil,
  };
}

export async function orchestrationCommand(
  connection: Connection,
  command: string,
  id: string | undefined,
  values: Parameters<typeof submission>[0] & {
    every?: string;
    commit?: string;
    target?: string;
    "target-head"?: string;
  },
): Promise<void> {
  let result: unknown;
  if (command === "group") {
    if (!id) throw new Error("group requires a JSON file with a tasks array.");
    result = await request(connection, "/groups", "POST", JSON.parse(await readFile(id, "utf8")));
  } else if (command === "routine") {
    if (!values.every || !/^\d+$/.test(values.every))
      throw new Error("routine requires --every MS.");
    result = await request(connection, "/routines", "POST", {
      interval: Number(values.every),
      task: submission(values),
    });
  } else if (command === "routines") {
    result = await request(connection, "/routines");
  } else if (command === "routine-pause" || command === "routine-resume") {
    if (!id || !/^[\w-]{1,128}$/.test(id)) throw new Error(`${command} requires a routine ID.`);
    result = await request(connection, `/routines/${id}/${command.slice(8)}`, "POST");
  } else if (command === "merge") {
    if (
      !id ||
      !/^[\w-]{1,128}$/.test(id) ||
      !values.commit ||
      !values.target ||
      !values["target-head"]
    )
      throw new Error(
        "merge requires a task ID, --commit SHA, --target BRANCH and --target-head SHA.",
      );
    result = await request(connection, `/tasks/${id}/merge`, "POST", {
      commit: values.commit,
      target: values.target,
      targetHead: values["target-head"],
    });
  }
  console.log(JSON.stringify(result, localTimes, 2));
}

export function localTimes(key: string, value: unknown): unknown {
  return typeof value === "number" && ["waitUntil", "firstAt", "scheduledAt"].includes(key)
    ? new Date(value).toLocaleString()
    : value;
}
