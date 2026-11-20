import type { DatabaseSync } from "node:sqlite";
import type { GitEvidence } from "../../protocol/orchestration.ts";
import type { EventData, Execution, ExecutionUpdate, Outcome, Task } from "../../protocol/task.ts";

export function transaction<T>(db: DatabaseSync, write: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = write();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function append(
  db: DatabaseSync,
  taskId: string,
  executionId: string | null,
  data: EventData,
  at = new Date().toISOString(),
): void {
  db.prepare("INSERT INTO events (taskId, executionId, at, data) VALUES (?, ?, ?, ?)").run(
    taskId,
    executionId,
    at,
    JSON.stringify(data),
  );
}

export const lostExecution =
  "Host restarted before confirming that the previous execution stopped.";

export function reconcile(db: DatabaseSync): void {
  transaction(db, () => {
    const rows = db
      .prepare(
        "SELECT taskId, executionId FROM executions WHERE status = 'running' AND device = 'local'",
      )
      .all();
    for (const row of rows) {
      const taskId = String(row.taskId);
      const executionId = String(row.executionId);
      db.prepare("UPDATE tasks SET status = 'waiting', reason = ? WHERE taskId = ?").run(
        lostExecution,
        taskId,
      );
      db.prepare("UPDATE executions SET status = 'waiting', reason = ? WHERE executionId = ?").run(
        lostExecution,
        executionId,
      );
      append(db, taskId, executionId, { type: "task.waiting", reason: lostExecution });
    }
  });
}

export function confirmStopped(db: DatabaseSync, taskId: string): void {
  const execution = db
    .prepare(`
    SELECT executionId, pgid FROM executions
    WHERE taskId = ? AND status = 'waiting' AND endedAt IS NULL AND device = 'local'
  `)
    .get(taskId);
  if (!execution || typeof execution.pgid !== "number") return;
  try {
    process.kill(-execution.pgid, 0);
    return;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) return;
  }

  const at = new Date().toISOString();
  const reason = "Confirmed the previous execution stopped.";
  db.prepare(
    "UPDATE executions SET status = 'failed', reason = ?, endedAt = ? WHERE executionId = ?",
  ).run(reason, at, execution.executionId);
  append(
    db,
    taskId,
    String(execution.executionId),
    { type: "execution.finished", status: "failed", reason, result: null },
    at,
  );
}

export function setTask(
  db: DatabaseSync,
  taskId: string,
  status: Task["status"],
  reason: string | null,
): void {
  db.prepare("UPDATE tasks SET status = ?, reason = ? WHERE taskId = ?").run(
    status,
    reason,
    taskId,
  );
}

export function applyUpdate(db: DatabaseSync, execution: Execution, event: ExecutionUpdate): void {
  if (event.type === "execution.session") {
    db.prepare("UPDATE executions SET nativeSessionId = ? WHERE executionId = ?").run(
      event.nativeSessionId,
      execution.executionId,
    );
  } else if (event.type === "execution.process") {
    db.prepare("UPDATE executions SET pgid = ? WHERE executionId = ?").run(
      event.pgid,
      execution.executionId,
    );
  }
  append(db, execution.taskId, execution.executionId, event);
}

export function applyFinish(
  db: DatabaseSync,
  execution: Execution,
  status: Outcome,
  reason: string | null,
  result: string | null,
  evidence?: GitEvidence,
): void {
  const at = new Date().toISOString();
  setTask(db, execution.taskId, status, reason);
  db.prepare(
    "UPDATE executions SET status = ?, reason = ?, result = ?, endedAt = ? WHERE executionId = ?",
  ).run(status, reason, result, at, execution.executionId);
  if (evidence)
    append(
      db,
      execution.taskId,
      execution.executionId,
      { type: "execution.evidence", evidence },
      at,
    );
  append(
    db,
    execution.taskId,
    execution.executionId,
    { type: "execution.finished", status, reason, result },
    at,
  );
}
