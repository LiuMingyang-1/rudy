import { closeSync, constants, fchmodSync, fstatSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initRoutines } from "./routines.ts";

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

const executions = `
  executionId TEXT PRIMARY KEY,
  taskId TEXT NOT NULL REFERENCES tasks(taskId),
  nativeSessionId TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  result TEXT,
  startedAt TEXT NOT NULL,
  endedAt TEXT,
  harness TEXT NOT NULL DEFAULT 'codex',
  pgid INTEGER
`;

export function initSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS tasks (
      taskId TEXT PRIMARY KEY,
      brief TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      createdAt TEXT NOT NULL,
      harness TEXT NOT NULL DEFAULT 'codex'
    );
    CREATE TABLE IF NOT EXISTS executions (${executions});
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
  const columns = db
    .prepare("PRAGMA table_info(executions)")
    .all()
    .map(({ name }) => name);
  if (!columns.includes("harness")) {
    db.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
    try {
      db.exec(`
        ALTER TABLE tasks ADD COLUMN harness TEXT NOT NULL DEFAULT 'codex';
        CREATE TABLE execution_history (${executions});
        INSERT INTO execution_history
          SELECT executions.*, 'codex', NULL FROM executions ORDER BY rowid;
        DROP TABLE executions;
        ALTER TABLE execution_history RENAME TO executions;
        COMMIT;
      `);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    } finally {
      db.exec("PRAGMA foreign_keys = ON");
    }
  } else if (!columns.includes("pgid")) {
    db.exec("ALTER TABLE executions ADD COLUMN pgid INTEGER");
  }
  db.exec("CREATE INDEX IF NOT EXISTS executions_task ON executions(taskId)");
  if (
    !db
      .prepare("PRAGMA table_info(tasks)")
      .all()
      .some(({ name }) => name === "plan")
  ) {
    db.exec("ALTER TABLE tasks ADD COLUMN plan TEXT");
  }
  if (!columns.includes("device")) {
    db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE executions ADD COLUMN device TEXT NOT NULL DEFAULT 'local';
      ALTER TABLE executions ADD COLUMN remoteSeq INTEGER NOT NULL DEFAULT 0;
      COMMIT;`);
  }
  initRoutines(db);
}
