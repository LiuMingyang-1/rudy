import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { authorized } from "../host/connection.ts";
import type { WorkerIdentity } from "../protocol/worker.ts";

const secret = () => randomBytes(32).toString("hex");
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export class Pairing {
  private readonly db: DatabaseSync;
  private code?: { digest: string; expires: number };
  private readonly now: () => number;

  constructor(db: DatabaseSync, now: () => number) {
    this.db = db;
    this.now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS worker_device (
      slot INTEGER PRIMARY KEY CHECK (slot = 1), device TEXT NOT NULL, digest TEXT NOT NULL
    )`);
  }

  issue(): string {
    const token = secret();
    this.code = { digest: hash(token), expires: this.now() + 300_000 };
    return token;
  }

  redeem(token: string, previous?: WorkerIdentity): WorkerIdentity | undefined {
    if (!this.code || this.code.expires <= this.now() || !authorized(this.code.digest, hash(token)))
      return;
    const current = this.db.prepare("SELECT device, digest FROM worker_device").get();
    if (current && String(current.digest).length === 64) return;
    const device =
      current &&
      previous &&
      previous.device === current.device &&
      authorized(String(current.digest).slice(1), hash(previous.token))
        ? previous.device
        : randomUUID();
    const identity = { device, token: secret() };
    this.db
      .prepare("INSERT OR REPLACE INTO worker_device VALUES (1, ?, ?)")
      .run(device, hash(identity.token));
    this.code = undefined;
    return identity;
  }

  authenticate(token: string): string | undefined {
    const row = this.db.prepare("SELECT device, digest FROM worker_device").get();
    if (row && String(row.digest).length === 64 && authorized(String(row.digest), hash(token)))
      return String(row.device);
  }

  device(): string | undefined {
    const row = this.db.prepare("SELECT device FROM worker_device WHERE length(digest) = 64").get();
    return row && String(row.device);
  }

  revoke(device: string): boolean {
    const revoked = this.db
      .prepare(
        "UPDATE worker_device SET digest = '-' || digest WHERE device = ? AND length(digest) = 64",
      )
      .run(device).changes;
    if (revoked) this.code = undefined;
    return Boolean(revoked);
  }
}
