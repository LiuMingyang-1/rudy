import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { checkpointRequest } from "../harness/checkpoint.ts";
import { previewer } from "../harness/output.ts";
import { type RunHarness, SessionUnavailable } from "../harness/process.ts";
import type { Checkpoint, Execution, Task } from "../protocol/task.ts";

const exec = promisify(execFile);

export async function continueTask(
  task: Task,
  history: Execution[],
  checkpoint: Checkpoint | null,
  root: string,
  run: RunHarness,
  signal: AbortSignal,
  report: Parameters<RunHarness>[2],
  dependency?: string,
): Promise<string> {
  const { brief, harness } = task;
  const workspace = task.git?.worktree ?? brief.workspace;
  const turn = { workspace, readOnly: task.review };
  const previous = history.at(-1);
  const sessionIndex = history.findLastIndex(
    (entry) => entry.harness === harness && entry.nativeSessionId,
  );
  const sessionId = history[sessionIndex]?.nativeSessionId;
  const briefText = [
    `Goal: ${brief.goal}`,
    `Workspace: ${workspace}`,
    `Completion conditions: ${brief.completion}`,
    brief.scope && `Scope: ${brief.scope}`,
    brief.constraints && `Constraints: ${brief.constraints}`,
    task.git && `Git baseline: ${task.git.baseline}`,
    task.review && "Review the upstream result. The worktree is read-only.",
    dependency,
  ]
    .filter(Boolean)
    .join("\n");
  if (!previous)
    return run({ ...turn, prompt: `${briefText}\n\n${checkpointRequest}` }, signal, report);

  const snapshot = await exec(
    "git",
    [
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "status",
      "--short",
      "--branch",
      "--",
      ".",
    ],
    {
      cwd: workspace,
      env: { PATH: process.env.PATH, GIT_CEILING_DIRECTORIES: dirname(root) },
      maxBuffer: 64 * 1024,
      timeout: 3000,
      signal,
    },
  ).then(
    ({ stdout }) => previewer(process.env)(stdout.trim()) || "(no changes reported)",
    () => "Git status unavailable. Inspect the current workspace before continuing.",
  );
  const state = `Current workspace Git status:\n${snapshot}`;
  const context = checkpoint
    ? `Last agent-reported checkpoint:\n${JSON.stringify(checkpoint, null, 2)}`
    : "No checkpoint is available. Context is limited. Inspect the current workspace.";
  const recent = [
    `Previous execution (${previous.harness}): ${previous.status}.`,
    previous.reason,
    previous.result && `Previous agent report: ${previous.result}`,
    context,
  ]
    .filter(Boolean)
    .join("\n\n");
  const continued = ["Continue the existing task.", dependency, state, checkpointRequest];
  if (sessionId) {
    if (history.slice(sessionIndex + 1).some((entry) => entry.harness !== harness))
      continued.splice(1, 0, "Progress since handoff:", recent);
    try {
      return await run({ ...turn, sessionId, prompt: continued.join("\n\n") }, signal, report);
    } catch (error) {
      if (!(error instanceof SessionUnavailable)) throw error;
      report({
        type: "execution.progress",
        message: "Saved session unavailable. Starting a new session from the task brief.",
      });
    }
  }
  if (!checkpoint) report({ type: "execution.progress", message: context });
  return run(
    {
      ...turn,
      prompt: [
        "Continue the existing task in a new session.",
        briefText,
        recent,
        state,
        checkpointRequest,
      ].join("\n\n"),
    },
    signal,
    report,
  );
}
