import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";

export interface SessionSummary {
  id: string;
  timestamp: number;
}

export interface RudySession {
  prompt(text: string): Promise<void>;
  reset(): Promise<void>;
  list(): Promise<SessionSummary[]>;
  resume(id: string): Promise<void>;
}

const sessionId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The optional storage root keeps offline tests away from the user's sessions. */
export async function openSession(
  agent: Agent,
  workspace: string,
  storageRoot = join(homedir(), ".rudy", "sessions"),
): Promise<RudySession> {
  if (agent.state.isStreaming) throw new Error("Session is busy.");
  const root = await realpath(workspace);
  const directory = join(storageRoot, createHash("sha256").update(root).digest("hex"));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const baseline = structuredClone(agent.state.messages);
  const pointer = join(directory, "current.json");
  let busy = false;
  let writeFailure: Error | undefined;

  async function pointTo(id: string): Promise<void> {
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

  async function create(): Promise<string> {
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
    await pointTo(id);
    return id;
  }

  async function read(id: string, repair: boolean): Promise<AgentMessage[]> {
    if (!sessionId.test(id)) throw new Error("Invalid session ID.");
    const file = join(directory, `${id}.jsonl`);
    const bytes = await readFile(file);
    const end = bytes.lastIndexOf(10) + 1;
    const lines = bytes.subarray(0, end).toString("utf8").split("\n");
    lines.pop();
    const messages: AgentMessage[] = [];
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
        if (record.type !== "message" || !isMessage(record.message)) {
          throw new Error(`Invalid message in session ${id}, line ${index + 1}.`);
        }
        messages.push(record.message);
      }
    }
    if (messages[0]?.role !== "system")
      throw new Error(`Missing system baseline in session ${id}.`);
    if (repair && end !== bytes.length) await truncate(file, end);
    return messages;
  }

  async function restore(id: string): Promise<void> {
    const messages = await read(id, true);
    // Track only the final tool-call batch. Earlier gaps stay exactly as recorded.
    const pending = new Map<string, string>();
    for (const message of messages) {
      if (message.role === "toolResult") {
        pending.delete(message.toolCallId);
      } else {
        pending.clear();
        if (message.role === "assistant") {
          for (const content of message.content) {
            if (content.type === "toolCall") pending.set(content.id, content.name);
          }
        }
      }
    }
    // Close interrupted calls without re-executing tools.
    const interrupted: AgentMessage[] = [...pending].map(([toolCallId, toolName]) => ({
      role: "toolResult",
      toolCallId,
      toolName,
      content: [
        { type: "text", text: "Tool execution was interrupted. The tool was not resumed." },
      ],
      isError: true,
      timestamp: Date.now(),
    }));
    if (interrupted.length) {
      await appendFile(
        join(directory, `${id}.jsonl`),
        interrupted.map((message) => `${JSON.stringify({ type: "message", message })}\n`).join(""),
      );
      messages.push(...interrupted);
    }
    await pointTo(id);
    agent.reset();
    agent.state.messages = messages;
    agent.sessionId = id;
    writeFailure = undefined;
  }

  let current: string;
  let contents: string | undefined;
  try {
    contents = await readFile(pointer, "utf8");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (contents === undefined) {
    current = await create();
    agent.sessionId = current;
  } else {
    let value: unknown;
    try {
      value = JSON.parse(contents);
    } catch {
      throw new Error("Corrupt current session pointer.");
    }
    if (!isRecord(value) || typeof value.id !== "string" || !sessionId.test(value.id)) {
      throw new Error("Invalid current session pointer.");
    }
    current = value.id;
    await restore(current);
  }

  async function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (busy || agent.state.isStreaming) throw new Error("Session is busy.");
    busy = true;
    try {
      return await operation();
    } finally {
      busy = false;
    }
  }

  return {
    prompt: (text) =>
      exclusive(async () => {
        if (writeFailure) throw writeFailure;
        const unsubscribe = agent.subscribe(async (event) => {
          if (event.type !== "message_end" || writeFailure) return;
          try {
            await appendFile(
              join(directory, `${current}.jsonl`),
              `${JSON.stringify({ type: "message", message: event.message })}\n`,
            );
          } catch {
            writeFailure = new Error(
              "Session write failed. Reopen or reset the session before continuing.",
            );
            agent.abort();
          }
        });
        try {
          await agent.prompt(text);
          if (writeFailure) throw writeFailure;
          if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
        } finally {
          unsubscribe();
        }
      }),
    reset: () =>
      exclusive(async () => {
        const id = await create();
        agent.reset();
        agent.state.messages = baseline;
        agent.sessionId = id;
        current = id;
        writeFailure = undefined;
      }),
    list: () =>
      exclusive(async () => {
        const sessions: SessionSummary[] = [];
        for (const name of await readdir(directory)) {
          if (!name.endsWith(".jsonl") || !sessionId.test(name.slice(0, -6))) continue;
          const id = name.slice(0, -6);
          const messages = await read(id, false);
          if (!messages.some((message) => message.role === "user")) continue;
          const timestamp = messages.reduce(
            (latest, message) =>
              message.role === "system" ? latest : Math.max(latest, message.timestamp),
            0,
          );
          sessions.push({ id, timestamp });
        }
        return sessions.sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id));
      }),
    resume: (id) =>
      exclusive(async () => {
        await restore(id);
        current = id;
      }),
  };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate the replay-critical fields while retaining provider-specific metadata. */
function isMessage(value: unknown): value is AgentMessage {
  if (!isRecord(value) || typeof value.timestamp !== "number" || !Number.isFinite(value.timestamp))
    return false;
  if (value.role === "system") {
    if (
      value.sections !== undefined &&
      (!isRecord(value.sections) ||
        !Object.values(value.sections).every(
          (section) => section === null || typeof section === "string",
        ))
    )
      return false;
    if (
      value.toolsAdded !== undefined &&
      (!Array.isArray(value.toolsAdded) ||
        !value.toolsAdded.every(
          (tool: unknown) =>
            isRecord(tool) &&
            typeof tool.name === "string" &&
            typeof tool.description === "string" &&
            isRecord(tool.parameters),
        ))
    )
      return false;
    if (
      value.toolsRemoved !== undefined &&
      (!Array.isArray(value.toolsRemoved) ||
        !value.toolsRemoved.every(
          (tool: unknown) => isRecord(tool) && typeof tool.name === "string",
        ))
    )
      return false;
  }
  const content = value.content;
  if (typeof content === "string") return value.role === "user" || value.role === "system";
  if (
    !Array.isArray(content) ||
    !content.every((part: unknown) => {
      if (!isRecord(part)) return false;
      switch (part.type) {
        case "text":
          return typeof part.text === "string";
        case "image":
          return (
            value.role !== "system" &&
            value.role !== "assistant" &&
            typeof part.data === "string" &&
            typeof part.mimeType === "string"
          );
        case "thinking":
          return value.role === "assistant" && typeof part.thinking === "string";
        case "toolCall":
          return (
            value.role === "assistant" &&
            typeof part.id === "string" &&
            typeof part.name === "string" &&
            isRecord(part.arguments)
          );
        default:
          return false;
      }
    })
  )
    return false;
  switch (value.role) {
    case "system":
    case "user":
      return true;
    case "toolResult":
      return (
        typeof value.toolCallId === "string" &&
        typeof value.toolName === "string" &&
        typeof value.isError === "boolean"
      );
    case "assistant": {
      const usage = value.usage;
      return (
        typeof value.api === "string" &&
        typeof value.provider === "string" &&
        typeof value.model === "string" &&
        ["stop", "length", "toolUse", "error", "aborted"].includes(String(value.stopReason)) &&
        isRecord(usage) &&
        isRecord(usage.cost) &&
        ["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every(
          (key) => typeof usage[key] === "number" && Number.isFinite(usage[key]),
        ) &&
        ["input", "output", "cacheRead", "cacheWrite", "total"].every(
          (key) =>
            isRecord(usage.cost) &&
            typeof usage.cost[key] === "number" &&
            Number.isFinite(usage.cost[key]),
        )
      );
    }
    default:
      return false;
  }
}
