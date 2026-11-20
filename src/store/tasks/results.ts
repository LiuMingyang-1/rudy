import type { DatabaseSync } from "node:sqlite";
import type { GitEvidence } from "../../protocol/orchestration.ts";
import type { Checkpoint } from "../../protocol/task.ts";

export function observedResult(
  db: DatabaseSync,
  taskId: string,
): { executionId: string; evidence: GitEvidence; result: string | null } | undefined {
  const row = db
    .prepare(`
    SELECT e.executionId, e.result, v.data FROM executions e JOIN events v USING (executionId)
    WHERE e.taskId = ? AND e.executionId = (
      SELECT executionId FROM executions WHERE taskId = ? ORDER BY rowid DESC LIMIT 1
    ) AND json_extract(v.data, '$.type') = 'execution.evidence'
  `)
    .get(taskId, taskId);
  return (
    row && {
      executionId: String(row.executionId),
      result: typeof row.result === "string" ? row.result : null,
      evidence: JSON.parse(String(row.data)).evidence,
    }
  );
}

export function observedCheckpoint(db: DatabaseSync, taskId: string): Checkpoint | null {
  const row = db
    .prepare(`
      SELECT data FROM events WHERE taskId = ? AND json_extract(data, '$.type') = 'execution.checkpoint'
      ORDER BY seq DESC LIMIT 1
    `)
    .get(taskId);
  return row ? JSON.parse(String(row.data)).checkpoint : null;
}
