import { runCodex } from "../harness/codex.ts";
import { previewer } from "../harness/output.ts";
import type { Outcome, Task } from "../protocol/task.ts";
import { lostExecution, type TaskStore } from "../store/tasks.ts";
import { contains, validateWorkspace } from "./workspace.ts";

export class LocalRunner {
  private active?: { taskId: string; abort: AbortController; done: Promise<void> };
  private stopped = false;
  private failure?: Error;
  private readonly store: TaskStore;
  private readonly root: string;
  private readonly executable: string;
  private readonly notify: () => void;

  constructor(store: TaskStore, root: string, executable: string, notify: () => void) {
    this.store = store;
    this.root = root;
    this.executable = executable;
    this.notify = notify;
  }

  get unavailable(): boolean {
    return this.stopped || Boolean(this.failure);
  }

  storageFailed(): void {
    this.failure ??= new Error("Rudy could not write to SQLite. Restart the Host to reconcile.");
    this.active?.abort.abort(this.failure.message);
  }

  dispatch(): void {
    if (this.active || this.unavailable) return;
    try {
      const unresolved = this.store.list("waiting").filter((task) => task.reason === lostExecution);
      for (const task of this.store.list("queued")) {
        const blocked = unresolved.find(
          ({ brief }) =>
            contains(brief.workspace, task.brief.workspace) ||
            contains(task.brief.workspace, brief.workspace),
        );
        if (blocked) {
          this.store.wait(
            task.taskId,
            `Workspace overlaps unconfirmed execution for task ${blocked.taskId}.`,
          );
          this.notify();
          continue;
        }
        const abort = new AbortController();
        const done = this.execute(task, abort.signal)
          .catch(() => this.storageFailed())
          .finally(() => {
            this.active = undefined;
            this.dispatch();
          });
        this.active = { taskId: task.taskId, abort, done };
        return;
      }
    } catch {
      this.storageFailed();
    }
  }

  private async execute(task: Task, signal: AbortSignal): Promise<void> {
    const execution = this.store.claim(task);
    this.notify();
    let status: Outcome = "succeeded";
    let reason: string | null = null;
    let result: string | null = null;
    try {
      const workspace = await validateWorkspace(this.root, task.brief.workspace);
      if (workspace !== task.brief.workspace)
        throw new Error("Workspace changed after submission.");
      signal.throwIfAborted();
      result = await runCodex(this.executable, task.brief, signal, (event) => {
        if (signal.aborted) return;
        try {
          this.store.update(execution, event);
          this.notify();
        } catch {
          this.storageFailed();
        }
      });
    } catch (error) {
      status = "failed";
      reason = previewer(process.env)(error instanceof Error ? error.message : String(error));
    }
    if (this.failure) return;
    if (signal.aborted) {
      status = this.stopped ? "failed" : "canceled";
      reason = String(signal.reason);
    }
    this.store.finish(execution, status, reason, result);
    this.notify();
  }

  cancel(task: Task): boolean {
    if (task.status === "queued") {
      this.store.cancelQueued(task.taskId);
      this.notify();
      return true;
    }
    if (task.status !== "running" || this.active?.taskId !== task.taskId) return false;
    this.active.abort.abort("Stopped by the user.");
    return true;
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.active?.abort.abort("Host shut down during execution.");
    await this.active?.done;
  }
}
