import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { TaskPlan } from "../protocol/orchestration.ts";
import { insertTask } from "./tasks/create.ts";
import { transaction } from "./tasks/journal.ts";

export function initRoutines(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS routines (
      id TEXT PRIMARY KEY, plan TEXT NOT NULL, interval INTEGER NOT NULL,
      firstAt INTEGER NOT NULL, enabled INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS routine_triggers (
      routineId TEXT REFERENCES routines(id), scheduledAt INTEGER NOT NULL,
      taskId TEXT REFERENCES tasks(taskId), PRIMARY KEY (routineId, scheduledAt)
    );
  `);
}

export class RoutineStore {
  private readonly db: DatabaseSync;
  private readonly worktrees: string;

  constructor(db: DatabaseSync, worktrees: string) {
    this.db = db;
    this.worktrees = worktrees;
  }

  create(plan: TaskPlan, interval: number, now: number) {
    const id = randomUUID();
    const firstAt = now + interval;
    this.db
      .prepare("INSERT INTO routines VALUES (?, ?, ?, ?, 1)")
      .run(id, JSON.stringify(plan), interval, firstAt);
    return { id, plan, interval, firstAt, enabled: true };
  }

  list() {
    return this.db
      .prepare("SELECT * FROM routines ORDER BY rowid")
      .all()
      .map((row) => ({
        ...row,
        plan: JSON.parse(String(row.plan)),
        enabled: row.enabled === 1,
        triggers: this.db
          .prepare(
            "SELECT scheduledAt, taskId FROM routine_triggers WHERE routineId = ? ORDER BY scheduledAt",
          )
          .all(row.id),
      }));
  }

  enable(id: string, enabled: boolean): boolean {
    return Boolean(
      this.db.prepare("UPDATE routines SET enabled = ? WHERE id = ?").run(+enabled, id).changes,
    );
  }

  tick(now: number): void {
    const due = this.db
      .prepare(`
      SELECT *, firstAt + ((CAST(? AS INTEGER) - firstAt) / interval) * interval AS scheduledAt
      FROM routines WHERE enabled = 1 AND firstAt <= ?
    `)
      .all(now, now);
    for (const { id, plan, scheduledAt } of due) {
      const routineId = String(id);
      if (
        this.db
          .prepare("SELECT 1 FROM routine_triggers WHERE routineId = ? AND scheduledAt >= ?")
          .get(routineId, scheduledAt)
      )
        continue;
      transaction(this.db, () => {
        const pending = this.db
          .prepare(`
          SELECT 1 FROM tasks WHERE json_extract(plan, '$.routineId') = ?
          AND status IN ('queued', 'running', 'waiting', 'paused')
        `)
          .get(routineId);
        const taskId = pending
          ? null
          : insertTask(this.db, JSON.parse(String(plan)), this.worktrees, now, undefined, routineId)
              .taskId;
        this.db
          .prepare("INSERT INTO routine_triggers VALUES (?, ?, ?)")
          .run(routineId, scheduledAt, taskId);
      });
    }
  }
}
