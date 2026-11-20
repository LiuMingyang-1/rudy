import { claude } from "../harness/claude.ts";
import { codex } from "../harness/codex.ts";
import type { RunHarness } from "../harness/process.ts";
import type { Harness, Task } from "../protocol/task.ts";
import { lostExecution } from "../store/tasks/journal.ts";
import type { TaskStore } from "../store/tasks/store.ts";
import { offline, type RemoteRunner } from "../worker/remote/runner.ts";
import { executeTask } from "./execution.ts";
import { dependencyWait, readiness, timeWait } from "./readiness.ts";
import { contains } from "./workspace.ts";

export class LocalRunner {
  private readonly active = new Map<
    string,
    { task: Task; abort: AbortController; done: Promise<void> }
  >();
  private stopped = false;
  private failure?: Error;
  private readonly store: TaskStore;
  private readonly root: string;
  private readonly harnesses: Record<Harness, RunHarness>;
  private readonly worktrees: string;
  private readonly now: () => number;
  private readonly remote?: RemoteRunner;
  private readonly notify: () => void;

  constructor(
    store: TaskStore,
    root: string,
    executables: Record<Harness, string>,
    notify: () => void,
    worktrees: string,
    now: () => number,
    remote?: RemoteRunner,
  ) {
    this.store = store;
    this.root = root;
    this.harnesses = {
      codex: codex(executables.codex),
      "claude-code": claude(executables["claude-code"]),
    };
    this.notify = notify;
    this.worktrees = worktrees;
    this.now = now;
    this.remote = remote;
  }

  get unavailable(): boolean {
    return this.stopped || Boolean(this.failure);
  }

  storageFailed(): void {
    this.failure ??= new Error("Rudy could not write to SQLite. Restart the Host to reconcile.");
    this.remote?.storageFailed();
    for (const { abort } of this.active.values()) abort.abort(this.failure.message);
  }

  occupied(path: string): boolean {
    return (
      [...this.active.values()].some(({ task }) => overlaps(path, workspace(task))) ||
      this.unresolved().some((task) => overlaps(path, workspace(task)))
    );
  }

  private unresolved(): Task[] {
    return this.store.list("waiting").filter((task) => task.reason === lostExecution);
  }

  dispatch(): void {
    if (this.unavailable) return;
    try {
      const unresolved = this.unresolved();
      const pending = this.store
        .list()
        .filter(
          ({ status, reason }) =>
            status === "queued" ||
            (status === "waiting" &&
              (reason === offline ||
                reason?.startsWith(dependencyWait) ||
                reason?.startsWith(timeWait))),
        );
      for (const task of pending) {
        const { reason, result } = readiness(this.store, task, this.now());
        if (reason) {
          if (task.reason !== reason) {
            this.store.wait(task.taskId, reason);
            this.notify();
          }
          continue;
        }
        if (task.remote) {
          this.remote?.dispatch(
            task,
            result && { ...result, checkpoint: this.store.checkpoint(task.after ?? "") },
          );
          continue;
        }
        const path = workspace(task);
        const blocked = unresolved.find((other) => overlaps(path, workspace(other)));
        if (blocked) {
          this.store.wait(
            task.taskId,
            `Workspace overlaps unconfirmed execution for task ${blocked.taskId}.`,
          );
          this.notify();
          continue;
        }
        if ([...this.active.values()].some(({ task: other }) => overlaps(path, workspace(other))))
          continue;
        const abort = new AbortController();
        const done = executeTask(
          {
            store: this.store,
            root: this.root,
            worktrees: this.worktrees,
            run: this.harnesses[task.harness],
            notify: this.notify,
            onStorageFailure: () => this.storageFailed(),
            failed: () => Boolean(this.failure),
            closing: () => this.stopped,
          },
          task,
          abort.signal,
          result,
        )
          .catch(() => this.storageFailed())
          .finally(() => {
            this.active.delete(task.taskId);
            this.dispatch();
          });
        this.active.set(task.taskId, { task, abort, done });
      }
    } catch {
      this.storageFailed();
    }
  }

  stop(task: Task, pause: boolean): boolean {
    if (
      !pause &&
      (task.status === "queued" ||
        (task.status === "waiting" &&
          this.store.executions(task.taskId).every(({ endedAt }) => endedAt)))
    ) {
      this.store.cancelQueued(task.taskId);
      this.notify();
      this.dispatch();
      return true;
    }
    if (task.remote) return this.remote?.stop(task, pause) ?? false;
    const active = this.active.get(task.taskId);
    if (!active) return false;
    active.abort.abort(pause ? "Paused by the user." : "Stopped by the user.");
    return true;
  }

  async close(): Promise<void> {
    this.stopped = true;
    for (const { abort } of this.active.values()) abort.abort("Host shut down during execution.");
    await Promise.all([...this.active.values()].map(({ done }) => done));
  }
}

const workspace = (task: Task) => task.git?.worktree ?? task.brief.workspace;

const overlaps = (first: string, second: string) =>
  contains(first, second) || contains(second, first);
