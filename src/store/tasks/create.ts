import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { TaskPlan } from "../../protocol/orchestration.ts";
import type { Task } from "../../protocol/task.ts";
import { append } from "./journal.ts";

export function insertTask(
  db: DatabaseSync,
  plan: TaskPlan,
  worktrees = "",
  now = Date.now(),
  previous?: Task,
  routineId?: string,
): Task {
  const taskId = randomUUID();
  const { brief, harness, baseline, review, waitUntil, remote } = plan;
  const git = review
    ? previous?.git
    : baseline
      ? {
          device: "local" as const,
          repository: brief.workspace,
          baseline,
          branch: `rudy/${taskId}`,
          worktree: join(worktrees, taskId),
        }
      : undefined;
  const after = previous?.taskId;
  const reason = after
    ? `Waiting for task ${after} to succeed.`
    : waitUntil !== undefined && waitUntil > now
      ? `Waiting until ${new Date(waitUntil).toISOString()}.`
      : null;
  const status = reason ? "waiting" : "queued";
  const createdAt = new Date(now).toISOString();
  const metadata = { git, review, after, waitUntil, routineId, remote };
  db.prepare(
    "INSERT INTO tasks (taskId, brief, harness, status, reason, createdAt, plan) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    taskId,
    JSON.stringify(brief),
    harness,
    status,
    reason,
    createdAt,
    JSON.stringify(metadata),
  );
  append(
    db,
    taskId,
    null,
    reason ? { type: "task.waiting", reason } : { type: "task.queued" },
    createdAt,
  );
  return { taskId, brief, harness, status, reason, createdAt, ...metadata };
}
