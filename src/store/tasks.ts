import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type Brief,
  type EventData,
  type Execution,
  eventPageSize,
  type Outcome,
  type Task,
  type TaskEvent,
} from "../protocol/task.ts";

export const lostExecution =
  "Host restarted before confirming that the previous execution stopped.";

function decodeTask(row: Record<string, unknown>): Task {
  const task = row as Omit<Task, "brief"> & { brief: string };
  return { ...task, brief: JSON.parse(task.brief) };
}

export class TaskStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  private transaction<T>(write: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = write();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private append(taskId: string, executionId: string | null, data: EventData, at: string): void {
    this.db
      .prepare("INSERT INTO events (taskId, executionId, at, data) VALUES (?, ?, ?, ?)")
      .run(taskId, executionId, at, JSON.stringify(data));
  }

  create(brief: Brief): Task {
    const task: Task = {
      taskId: randomUUID(),
      brief,
      status: "queued",
      reason: null,
      createdAt: new Date().toISOString(),
    };
    return this.transaction(() => {
      this.db
        .prepare("INSERT INTO tasks VALUES (?, ?, ?, NULL, ?)")
        .run(task.taskId, JSON.stringify(brief), task.status, task.createdAt);
      this.append(task.taskId, null, { type: "task.queued" }, task.createdAt);
      return task;
    });
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
      .prepare("SELECT * FROM executions WHERE taskId = ? ORDER BY rowid")
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

  claim(task: Task): Execution {
    const execution: Execution = {
      executionId: randomUUID(),
      taskId: task.taskId,
      nativeSessionId: null,
      status: "running",
      reason: null,
      result: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
    };
    return this.transaction(() => {
      this.setTask(task.taskId, "running", null);
      this.db
        .prepare("INSERT INTO executions VALUES (?, ?, NULL, 'running', NULL, NULL, ?, NULL)")
        .run(execution.executionId, task.taskId, execution.startedAt);
      this.append(
        task.taskId,
        execution.executionId,
        { type: "execution.started" },
        execution.startedAt,
      );
      return execution;
    });
  }

  update(
    execution: Execution,
    event: Extract<EventData, { type: "execution.session" | "execution.progress" }>,
  ): void {
    this.transaction(() => {
      if (event.type === "execution.session") {
        this.db
          .prepare("UPDATE executions SET nativeSessionId = ? WHERE executionId = ?")
          .run(event.nativeSessionId, execution.executionId);
      }
      this.append(execution.taskId, execution.executionId, event, new Date().toISOString());
    });
  }

  finish(
    execution: Execution,
    status: Outcome,
    reason: string | null,
    result: string | null,
  ): void {
    const at = new Date().toISOString();
    this.transaction(() => {
      this.setTask(execution.taskId, status, reason);
      this.db
        .prepare(
          "UPDATE executions SET status = ?, reason = ?, result = ?, endedAt = ? WHERE executionId = ?",
        )
        .run(status, reason, result, at, execution.executionId);
      this.append(
        execution.taskId,
        execution.executionId,
        { type: "execution.finished", status, reason, result },
        at,
      );
    });
  }

  cancelQueued(taskId: string): void {
    const reason = "Canceled before starting.";
    this.transaction(() => {
      this.setTask(taskId, "canceled", reason);
      this.append(taskId, null, { type: "task.canceled", reason }, new Date().toISOString());
    });
  }

  reconcile(): void {
    this.transaction(() => {
      const rows = this.db
        .prepare("SELECT taskId, executionId FROM executions WHERE status = 'running'")
        .all();
      for (const row of rows) {
        const taskId = String(row.taskId);
        const executionId = String(row.executionId);
        this.setTask(taskId, "waiting", lostExecution);
        this.db
          .prepare("UPDATE executions SET status = 'waiting', reason = ? WHERE executionId = ?")
          .run(lostExecution, executionId);
        this.append(
          taskId,
          executionId,
          { type: "task.waiting", reason: lostExecution },
          new Date().toISOString(),
        );
      }
    });
  }

  wait(taskId: string, reason: string): void {
    this.transaction(() => {
      this.setTask(taskId, "waiting", reason);
      this.append(taskId, null, { type: "task.waiting", reason }, new Date().toISOString());
    });
  }

  private setTask(taskId: string, status: Task["status"], reason: string | null): void {
    this.db
      .prepare("UPDATE tasks SET status = ?, reason = ? WHERE taskId = ?")
      .run(status, reason, taskId);
  }
}
