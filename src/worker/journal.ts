import type { DatabaseSync } from "node:sqlite";
import type { WorkerMessage } from "../protocol/worker.ts";
import { transaction } from "../store/tasks/journal.ts";

export type Frame = Extract<WorkerMessage, { type: "event" }>;

export class WorkerJournal {
  private readonly db: DatabaseSync;
  private readonly device: string;

  constructor(db: DatabaseSync, device: string) {
    this.db = db;
    this.device = device;
    db.exec(`
      CREATE TABLE IF NOT EXISTS claims (
        id TEXT PRIMARY KEY, device TEXT NOT NULL, last INTEGER NOT NULL,
        acknowledged INTEGER NOT NULL, finished INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS frames (
        id TEXT NOT NULL REFERENCES claims(id), seq INTEGER NOT NULL, event TEXT NOT NULL,
        PRIMARY KEY (id, seq)
      );
    `);
  }

  held(active?: string) {
    return this.db
      .prepare(`
      SELECT id, last, acknowledged FROM claims WHERE device = ? AND (finished = 1 OR id = ?)
    `)
      .all(this.device, active ?? "")
      .map(({ id, last, acknowledged }) => ({
        id: String(id),
        last: Number(last),
        acknowledged: Number(acknowledged),
      }));
  }

  claim(id: string): boolean {
    return Boolean(
      this.db.prepare("INSERT OR IGNORE INTO claims VALUES (?, ?, 0, 0, 0)").run(id, this.device)
        .changes,
    );
  }

  append(frame: Frame): void {
    transaction(this.db, () => {
      this.db
        .prepare("UPDATE claims SET last = ?, finished = ? WHERE id = ?")
        .run(frame.seq, Number(frame.event.type === "execution.finished"), frame.id);
      this.db
        .prepare("INSERT INTO frames VALUES (?, ?, ?)")
        .run(frame.id, frame.seq, JSON.stringify(frame.event));
    });
  }

  replay(id: string): Frame[] {
    return this.db
      .prepare("SELECT seq, event FROM frames WHERE id = ? ORDER BY seq")
      .all(id)
      .map(({ seq, event }) => ({
        type: "event",
        id,
        seq: Number(seq),
        event: JSON.parse(String(event)),
      }));
  }

  acknowledge(id: string, seq: number): void {
    transaction(this.db, () => {
      if (
        this.db
          .prepare(
            "UPDATE claims SET acknowledged = ? WHERE id = ? AND device = ? AND acknowledged < ? AND last >= ?",
          )
          .run(seq, id, this.device, seq, seq).changes
      )
        this.db.prepare("DELETE FROM frames WHERE id = ? AND seq <= ?").run(id, seq);
    });
  }
}
