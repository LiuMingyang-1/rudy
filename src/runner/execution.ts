import { previewer } from "../harness/output.ts";
import type { RunHarness } from "../harness/process.ts";
import type { GitEvidence } from "../protocol/orchestration.ts";
import type { ExecutionUpdate, Outcome, Task } from "../protocol/task.ts";
import type { ExecutionInput, Finished } from "../protocol/worker.ts";
import type { TaskStore } from "../store/tasks/store.ts";
import { continueTask } from "./continuation.ts";
import { checkResult, prepareWorktree, snapshot } from "./git.ts";
import { validateWorkspace } from "./workspace.ts";

interface WorkspaceContext {
  root: string;
  worktrees: string;
  run: RunHarness;
}

interface ExecutionContext extends WorkspaceContext {
  store: TaskStore;
  notify: () => void;
  onStorageFailure: () => void;
  failed: () => boolean;
  closing: () => boolean;
}

export async function executeTask(
  context: ExecutionContext,
  task: Task,
  signal: AbortSignal,
  upstream: ReturnType<TaskStore["result"]>,
): Promise<void> {
  const { store, notify, onStorageFailure } = context;
  const input = {
    task,
    history: store.executions(task.taskId),
    checkpoint: store.checkpoint(task.taskId),
    upstream: upstream && { ...upstream, checkpoint: store.checkpoint(task.after ?? "") },
  };
  const execution = store.claim(task);
  notify();
  const outcome = await runExecution(
    context,
    input,
    signal,
    (event) => {
      try {
        store.update(execution, event);
        notify();
      } catch {
        onStorageFailure();
      }
    },
    context.closing,
  );
  if (context.failed()) return;
  const { status, reason, result, evidence } = outcome;
  store.finish(execution, status, reason, result, evidence);
  notify();
}

export async function runExecution(
  { root, worktrees, run }: WorkspaceContext,
  { task, history, checkpoint, upstream }: ExecutionInput,
  signal: AbortSignal,
  report: (event: ExecutionUpdate) => void,
  closing = () => false,
): Promise<Finished> {
  const commands: GitEvidence["commands"] = [];
  let status: Outcome = "succeeded";
  let reason: string | null = null;
  let result: string | null = null;
  let evidence: GitEvidence | undefined;
  try {
    status = "waiting";
    const workspace = await validateWorkspace(root, task.brief.workspace);
    if (workspace !== task.brief.workspace) throw new Error("Workspace changed after submission.");
    status = "failed";
    signal.throwIfAborted();
    if (task.git)
      prepareWorktree(
        task.git,
        worktrees,
        !task.review && history.every(({ pgid, nativeSessionId }) => !pgid && !nativeSessionId),
      );
    if (task.git && task.review && upstream) checkResult(task.git, upstream.evidence.commit);
    result = await continueTask(
      task,
      history,
      checkpoint,
      root,
      run,
      signal,
      (event) => {
        if (signal.aborted) return;
        if (event.type === "execution.command") commands.push(event.result);
        report(event);
      },
      upstream &&
        `Upstream task ${task.after}, execution ${upstream.executionId}.
Runner evidence: ${JSON.stringify(upstream.evidence)}
Upstream agent report: ${upstream.result ?? "(none)"}
Upstream agent checkpoint: ${JSON.stringify(upstream.checkpoint)}`,
    );
    signal.throwIfAborted();
    if (task.git) {
      prepareWorktree(task.git, worktrees, false);
      if (task.review && upstream) {
        checkResult(task.git, upstream.evidence.commit);
        evidence = { ...upstream.evidence, commands, upstreamExecutionId: upstream.executionId };
      } else evidence = { ...snapshot(task.git), commands };
    }
    status = "succeeded";
  } catch (error) {
    reason = previewer(process.env)(error instanceof Error ? error.message : String(error));
  }
  if (signal.aborted) {
    status = closing() ? "failed" : signal.reason === "Paused by the user." ? "paused" : "canceled";
    reason = String(signal.reason);
  }
  return { type: "execution.finished", status, reason, result, evidence };
}
