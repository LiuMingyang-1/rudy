import type { DatabaseSync } from "node:sqlite";
import type { Execution } from "../../protocol/task.ts";
import { reconnecting, type WorkerMessage, waitingDevice } from "../../protocol/worker.ts";
import { append, applyFinish, applyUpdate, setTask, transaction } from "./journal.ts";

type Frame = Extract<WorkerMessage, { type: "event" }>;
type RemoteExecution = Execution & { remoteSeq: number };

export class RemoteJournal {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  open(): RemoteExecution[] {
    return this.db
      .prepare("SELECT * FROM executions WHERE device != 'local' AND endedAt IS NULL")
      .all() as unknown as RemoteExecution[];
  }

  presence(execution: RemoteExecution, reason: string | null): void {
    if (execution.reason === reason) return;
    const { taskId, executionId, device } = execution;
    const status = reason?.startsWith(waitingDevice) ? "waiting" : "running";
    transaction(this.db, () => {
      setTask(this.db, taskId, status, reason);
      this.db
        .prepare("UPDATE executions SET status = ?, reason = ? WHERE executionId = ?")
        .run(status, reason, executionId);
      append(
        this.db,
        taskId,
        executionId,
        status === "waiting"
          ? { type: "task.waiting", reason: reason ?? waitingDevice }
          : {
              type: reason === reconnecting ? "execution.reconnecting" : "execution.reconnected",
              device,
            },
      );
    });
  }

  event(device: string, { id, seq, event }: Frame): number | undefined {
    const execution = this.db
      .prepare("SELECT * FROM executions WHERE executionId = ? AND device = ?")
      .get(id, device) as unknown as RemoteExecution | undefined;
    if (!execution) return;
    if (seq <= execution.remoteSeq || execution.endedAt) return execution.remoteSeq;
    if (seq !== execution.remoteSeq + 1) return;
    const { taskId } = execution;
    return transaction(this.db, () => {
      switch (event.type) {
        case "execution.finished":
          applyFinish(this.db, execution, event.status, event.reason, event.result, event.evidence);
          break;
        case "execution.workspace":
          this.db
            .prepare("UPDATE tasks SET plan = json_patch(plan, ?) WHERE taskId = ?")
            .run(
              JSON.stringify({ remote: { workspace: event.workspace }, git: event.git }),
              taskId,
            );
          append(this.db, taskId, id, event);
          break;
        case "execution.received":
        case "execution.started":
          append(this.db, taskId, id, { type: event.type, device });
          break;
        default:
          applyUpdate(this.db, execution, event);
      }
      this.db.prepare("UPDATE executions SET remoteSeq = ? WHERE executionId = ?").run(seq, id);
      return seq;
    });
  }
}
