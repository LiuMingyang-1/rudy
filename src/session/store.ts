import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type CompactionRecord, isCompaction, isMessage, isRecord, sessionId } from "./records.ts";

export interface SessionSummary {
  id: string;
  timestamp: number;
}

export interface SessionStore {
  readPointer(): Promise<string | undefined>;
  point(id: string): Promise<void>;
  create(baseline: AgentMessage[]): Promise<string>;
  read(
    id: string,
    repair: boolean,
  ): Promise<{ messages: AgentMessage[]; compaction?: CompactionRecord }>;
  append(id: string, records: object[]): Promise<void>;
  summaries(): Promise<SessionSummary[]>;
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function openStore(storageRoot: string, root: string): Promise<SessionStore> {
  const directory = join(storageRoot, createHash("sha256").update(root).digest("hex"));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const pointer = join(directory, "current.json");

  async function readPointer(): Promise<string | undefined> {
    let contents: string;
    try {
      contents = await readFile(pointer, "utf8");
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(contents);
    } catch {
      throw new Error("Corrupt current session pointer.");
    }
    if (!isRecord(value) || typeof value.id !== "string" || !sessionId.test(value.id)) {
      throw new Error("Invalid current session pointer.");
    }
    return value.id;
  }

  async function point(id: string): Promise<void> {
    const temporary = join(directory, `${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify({ id })}\n`, { flag: "wx", mode: 0o600 });
      await rename(temporary, pointer);
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (!isMissing(error)) throw error;
      });
    }
  }

  async function create(baseline: AgentMessage[]): Promise<string> {
    const id = randomUUID();
    const records = [
      { type: "session", version: 1, id, workspace: root },
      ...baseline.map((message) => ({ type: "message", message })),
    ];
    await writeFile(
      join(directory, `${id}.jsonl`),
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      {
        flag: "wx",
        mode: 0o600,
      },
    );
    await point(id);
    return id;
  }

  async function read(
    id: string,
    repair: boolean,
  ): Promise<{ messages: AgentMessage[]; compaction?: CompactionRecord }> {
    if (!sessionId.test(id)) throw new Error("Invalid session ID.");
    const file = join(directory, `${id}.jsonl`);
    const bytes = await readFile(file);
    const end = bytes.lastIndexOf(10) + 1;
    const lines = bytes.subarray(0, end).toString("utf8").split("\n");
    lines.pop();
    const messages: AgentMessage[] = [];
    let compaction: CompactionRecord | undefined;
    for (const [index, line] of lines.entries()) {
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        throw new Error(`Corrupt session ${id}, line ${index + 1}.`);
      }
      if (!isRecord(record)) throw new Error(`Invalid session record in ${id}.`);
      if (index === 0) {
        if (
          record.type !== "session" ||
          record.version !== 1 ||
          record.id !== id ||
          record.workspace !== root
        ) {
          throw new Error(`Unsupported or mismatched session header in ${id}.`);
        }
      } else {
        if (record.type === "compaction") {
          if (
            !isCompaction(record, messages.length) ||
            messages[record.firstKept - 1]?.role === "toolResult" ||
            (compaction && record.firstKept < compaction.firstKept)
          )
            throw new Error(`Invalid compaction in session ${id}, line ${index + 1}.`);
          compaction = record;
          continue;
        }
        if (record.type !== "message" || !isMessage(record.message)) {
          throw new Error(`Invalid message in session ${id}, line ${index + 1}.`);
        }
        messages.push(record.message);
      }
    }
    if (messages[0]?.role !== "system")
      throw new Error(`Missing system baseline in session ${id}.`);
    if (repair && end !== bytes.length) await truncate(file, end);
    return { messages, compaction };
  }

  async function ids(): Promise<string[]> {
    const ids: string[] = [];
    for (const name of await readdir(directory)) {
      if (!name.endsWith(".jsonl") || !sessionId.test(name.slice(0, -6))) continue;
      ids.push(name.slice(0, -6));
    }
    return ids;
  }

  async function summaries(): Promise<SessionSummary[]> {
    const sessions: SessionSummary[] = [];
    for (const id of await ids()) {
      const { messages } = await read(id, false);
      if (!messages.some((message) => message.role === "user")) continue;
      const timestamp = messages.reduce(
        (latest, message) =>
          message.role === "system" ? latest : Math.max(latest, message.timestamp),
        0,
      );
      sessions.push({ id, timestamp });
    }
    return sessions.sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id));
  }

  return {
    readPointer,
    point,
    create,
    read,
    append: (id, records) =>
      appendFile(
        join(directory, `${id}.jsonl`),
        records.map((record) => `${JSON.stringify(record)}\n`).join(""),
      ),
    summaries,
  };
}
