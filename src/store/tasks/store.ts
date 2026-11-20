import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { GitEvidence, TaskPlan } from "../../protocol/orchestration.ts";
import {
  type Brief,
  type Checkpoint,
  type EventData,
  type Execution,
  type ExecutionUpdate,
  eventPageSize,
  type Harness,
  type Outcome,
  type Task,
  type TaskEvent,
} from "../../protocol/task.ts";
import { insertTask } from "./create.ts";
import {
  append,
  applyFinish,
  applyUpdate,
  confirmStopped,
  setTask,
  transaction,
} from "./journal.ts";
import { observedCheckpoint, observedResult } from "./results.ts";

function decodeTask(row: Record<string, unknown>): Task {
  const { brief, plan, ...task } = row;
  return { ...task, ...JSON.parse(String(plan ?? "{}")), brief: JSON.parse(String(brief)) };
}

export class TaskStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  create(brief: Brief): Task {
    return this.createChain([{ brief, harness: "codex" }], "", Date.now())[0];
  }

  createChain(plans: TaskPlan[], worktrees: string, now: number): Task[] {
    return transaction(this.db, () => {
      const tasks: Task[] = [];
      for (const plan of plans) tasks.push(insertTask(this.db, plan, worktrees, now, tasks.at(-1)));
      return tasks;
    });
  }

  result(taskId: string) {
    return observedResult(this.db, taskId);
  }

  record(taskId: string, event: EventData): void {
    append(this.db, taskId, null, event);
  }

  list(status?: Task["status"]): Task[] {
    const order = "ORDER BY rowid";
    const rows = status
      ? this.db.prepare(`SELECT * FROM tasks WHERE status = ? ${order}`).all(status)
      : this.db.prepare(`SELECT * FROM tasks ${order}`).all();
    return rows.map(decodeTask);
  }

  get(taskId: string): Task | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE taskId = ?").get(taskId);
    return row && decodeTask(row);
  }

  executions(taskId: string): Execution[] {
    return this.db
      .prepare(
        "SELECT executionId, taskId, harness, nativeSessionId, pgid, device, status, reason, result, startedAt, endedAt FROM executions WHERE taskId = ? ORDER BY rowid",
      )
      .all(taskId) as unknown as Execution[];
  }

  events(taskId: string, after: number): TaskEvent[] {
    const rows = this.db
      .prepare(
        "SELECT seq, taskId, executionId, at, data FROM events WHERE taskId = ? AND seq > ? ORDER BY seq LIMIT ?",
      )
      .all(taskId, after, eventPageSize);
    return rows.map(({ data, ...event }) => ({ ...event, ...JSON.parse(String(data)) }));
  }

  checkpoint(taskId: string): Checkpoint | null {
    return observedCheckpoint(this.db, taskId);
  }

  requeue(taskId: string, harness: Harness): boolean {
    return transaction(this.db, () => {
      confirmStopped(this.db, taskId);
      const result = this.db
        .prepare(`
        UPDATE tasks SET harness = ?, status = 'queued', reason = NULL
        WHERE taskId = ? AND status NOT IN ('queued', 'running')
          AND NOT EXISTS (SELECT 1 FROM executions WHERE taskId = ? AND endedAt IS NULL)
      `)
        .run(harness, taskId, taskId);
      if (!result.changes) return false;
      append(this.db, taskId, null, { type: "task.queued" });
      return true;
    });
  }

  claim(task: Task): Execution {
    const execution: Execution = {
      executionId: randomUUID(),
      taskId: task.taskId,
      harness: task.harness,
      nativeSessionId: null,
      pgid: null,
      device: task.remote?.device ?? "local",
      status: "running",
      reason: null,
      result: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
    };
    return transaction(this.db, () => {
      setTask(this.db, task.taskId, "running", null);
      this.db
        .prepare(
          "INSERT INTO executions (executionId, taskId, status, startedAt, harness, device) VALUES (?, ?, 'running', ?, ?, ?)",
        )
        .run(
          execution.executionId,
          task.taskId,
          execution.startedAt,
          task.harness,
          execution.device,
        );
      append(
        this.db,
        task.taskId,
        execution.executionId,
        task.remote
          ? { type: "execution.dispatched", device: execution.device }
          : { type: "execution.started" },
        execution.startedAt,
      );
      return execution;
    });
  }

  update(execution: Execution, event: ExecutionUpdate): void {
    transaction(this.db, () => applyUpdate(this.db, execution, event));
  }

  finish(
    execution: Execution,
    status: Outcome,
    reason: string | null,
    result: string | null,
    evidence?: GitEvidence,
  ): void {
    transaction(this.db, () => applyFinish(this.db, execution, status, reason, result, evidence));
  }

  cancelQueued(taskId: string): void {
    const reason = "Canceled before starting.";
    transaction(this.db, () => {
      setTask(this.db, taskId, "canceled", reason);
      append(this.db, taskId, null, { type: "task.canceled", reason });
    });
  }

  wait(taskId: string, reason: string): void {
    transaction(this.db, () => {
      setTask(this.db, taskId, "waiting", reason);
      append(this.db, taskId, null, { type: "task.waiting", reason }, new Date().toISOString());
    });
  }
}
