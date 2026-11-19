import { closeSync, constants, fchmodSync, fstatSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openPrivateDatabase(path: string): DatabaseSync {
  const file = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    if (!fstatSync(file).isFile()) throw new Error("Expected a regular database file.");
    fchmodSync(file, 0o600);
  } finally {
    closeSync(file);
  }
  return new DatabaseSync(path);
}

// Separate from the WAL so a second Host cannot reconcile a live Host's executions.
export function claimHost(dataDir: string): DatabaseSync {
  const lock = openPrivateDatabase(join(dataDir, "host-lock.sqlite"));
  try {
    lock.exec("BEGIN EXCLUSIVE");
    return lock;
  } catch (error) {
    lock.close();
    throw new Error("Cannot claim the data directory. Check for another running Rudy Host.", {
      cause: error,
    });
  }
}

export function initSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS tasks (
      taskId TEXT PRIMARY KEY,
      brief TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS executions (
      executionId TEXT PRIMARY KEY,
      taskId TEXT NOT NULL UNIQUE REFERENCES tasks(taskId),
      nativeSessionId TEXT,
      status TEXT NOT NULL,
      reason TEXT,
      result TEXT,
      startedAt TEXT NOT NULL,
      endedAt TEXT
    );
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      taskId TEXT NOT NULL REFERENCES tasks(taskId),
      executionId TEXT REFERENCES executions(executionId),
      at TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_task_seq ON events(taskId, seq);
    CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
  `);
}
