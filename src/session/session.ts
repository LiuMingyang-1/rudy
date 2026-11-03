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
import type { Agent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  type CompactionOptions,
  type CompactionRecord,
  estimateMessages,
  generateSummary,
  projectHistory,
  recentStart,
} from "./compaction.ts";

export interface SessionSummary {
  id: string;
  timestamp: number;
}

export interface RudySession {
  prompt(text: string): Promise<void>;
  reset(): Promise<void>;
  list(): Promise<SessionSummary[]>;
  resume(id: string): Promise<void>;
  compact(): Promise<boolean>;
  readonly busy: boolean;
  cancel(): void;
}

const sessionId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The optional storage root keeps offline tests away from the user's sessions. */
export async function openSession(
  agent: Agent,
  workspace: string,
  storageRoot = join(homedir(), ".rudy", "sessions"),
  options: CompactionOptions = {},
): Promise<RudySession> {
  if (agent.state.isStreaming) throw new Error("Session is busy.");
  const root = await realpath(workspace);
  const directory = join(storageRoot, createHash("sha256").update(root).digest("hex"));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let raw: AgentMessage[] = [];
  let checkpoint: CompactionRecord | undefined;
  let usageBase: { messages: AgentMessage[]; model: string; tokens: number } | undefined;
  let controller: AbortController | undefined;
  const historyParameters = Type.Object(
    { cursor: Type.Optional(Type.String()) },
    { additionalProperties: false },
  );
  const historyTool: AgentTool<typeof historyParameters> = {
    name: "read_session_history",
    label: "Read session history",
    description:
      "Read original messages from this session only, newest compressed history first. Summary details may be wrong; retrieve relevant pages only. Returns up to 50 messages and 16000 characters per page; use nextCursor to continue. No file paths or other sessions are accepted.",
    parameters: historyParameters,
    execute: async (_id, args, signal) => {
      signal?.throwIfAborted();
      const cursor = args.cursor;
      if (cursor === "") throw new Error("Invalid history cursor.");
      let index = (checkpoint?.firstKept ?? raw.length + 1) - 2;
      let offset = 0;
      if (cursor) {
        const match = /^(\d+):(\d+):([0-9a-f-]+)$/.exec(cursor);
        if (!match || match[3] !== current) throw new Error("Invalid history cursor.");
        index = Number(match[1]) - 1;
        offset = Number(match[2]);
        if (
          !Number.isSafeInteger(index) ||
          !Number.isSafeInteger(offset) ||
          index < 0 ||
          index >= raw.length
        )
          throw new Error("Invalid history cursor.");
      }
      const entries: {
        number: number;
        role: string;
        offset: number;
        fragment: string;
        toolCallIds?: string[];
      }[] = [];
      let remaining = 12000;
      while (index >= 0 && entries.length < 50 && remaining > 0) {
        const message = raw[index];
        if (!message) break;
        const text = JSON.stringify(message);
        if (offset >= text.length) throw new Error("Invalid history cursor offset.");
        let fragment = text.slice(offset, offset + remaining);
        const toolCallIds =
          message.role === "toolResult"
            ? [message.toolCallId]
            : message.role === "assistant"
              ? message.content.flatMap((part) => (part.type === "toolCall" ? [part.id] : []))
              : undefined;
        const entry = { number: index + 1, role: message.role, offset, fragment, toolCallIds };
        while (
          fragment &&
          JSON.stringify({
            entries: [...entries, { ...entry, fragment }],
            nextCursor: `${index + 1}:${offset + fragment.length}:${current}`,
          }).length > 16000
        ) {
          fragment = fragment.slice(0, Math.floor(fragment.length / 2));
        }
        if (!fragment) break;
        entries.push({ ...entry, fragment });
        remaining -= fragment.length;
        offset += fragment.length;
        if (offset < text.length) break;
        index--;
        offset = 0;
      }
      const nextCursor = index >= 0 ? `${index + 1}:${offset}:${current}` : undefined;
      return {
        content: [{ type: "text", text: JSON.stringify({ entries, nextCursor }) }],
        details: {},
      };
    },
  };
  agent.state.tools = [
    ...agent.state.tools.filter((tool) => tool.name !== historyTool.name),
    historyTool,
  ];
  // Materialize tool declarations in the baseline before writing a new session.
  const initialSystem = agent.state.messages[0];
  if (initialSystem?.role === "system") {
    agent.state.messages = [
      {
        ...initialSystem,
        toolsAdded: agent.state.tools.map(({ name, description, parameters }) => ({
          name,
          description,
          parameters,
        })),
      },
      ...agent.state.messages.slice(1),
    ];
  }
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

  async function restore(id: string): Promise<void> {
    const { messages, compaction } = await read(id, true);
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
    agent.state.messages = projectHistory(messages, compaction);
    agent.sessionId = id;
    writeFailure = undefined;
    raw = messages;
    checkpoint = compaction;
    usageBase = undefined;
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
    raw = [...baseline];
    agent.state.messages = baseline;
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
    controller = new AbortController();
    try {
      return await operation();
    } finally {
      busy = false;
      controller = undefined;
    }
  }

  async function persist(record: object): Promise<void> {
    if (writeFailure) throw writeFailure;
    try {
      await appendFile(join(directory, `${current}.jsonl`), `${JSON.stringify(record)}\n`);
    } catch {
      writeFailure = new Error(
        "Session write failed. Reopen or reset the session before continuing.",
      );
      agent.abort();
      throw writeFailure;
    }
  }

  function estimate(messages: AgentMessage[], model: Model<Api>): number {
    if (
      usageBase &&
      usageBase.model === modelKey(model) &&
      usageBase.messages.every((message, index) => messages[index] === message)
    ) {
      return usageBase.tokens + estimateMessages(messages.slice(usageBase.messages.length));
    }
    return estimateMessages(messages);
  }

  async function compact(
    messages: AgentMessage[],
    model: Model<Api>,
    manual: boolean,
    signal?: AbortSignal,
  ): Promise<AgentMessage[] | undefined> {
    if (writeFailure) throw writeFailure;
    signal?.throwIfAborted();
    const before = estimate(messages, model);
    const output = Math.min(options.maxTokens ?? 4096, model.maxTokens);
    const fits = (tokens: number) => tokens + output + 1024 < model.contextWindow;
    if (
      !manual &&
      before < model.contextWindow * (options.compactionThreshold ?? 0.8) &&
      fits(before)
    )
      return;
    const conversation = messages.filter((message) => message.role !== "system");
    // The synthetic summary is already represented by the checkpoint, not a raw ordinal.
    const recent = checkpoint ? conversation.slice(1) : conversation;
    const start = recentStart(recent, options.compactionKeepRecentTokens ?? 20000);
    if (start === 0) {
      if (!fits(before))
        throw new Error(
          "Context and output do not fit the model window; no history can be compacted.",
        );
      return;
    }
    const tail = recent.slice(start);
    const first = tail[0];
    const firstKept = first ? raw.indexOf(first) + 1 : raw.length + 1;
    if (checkpoint && firstKept <= checkpoint.firstKept) {
      if (!fits(before)) throw new Error("Context still does not fit after compaction.");
      return;
    }
    const result = await generateSummary(
      agent,
      model,
      messages,
      options.compactionMaxTokens ?? 8192,
      signal,
    );
    const record: CompactionRecord = {
      type: "compaction",
      ...result,
      timestamp: Date.now(),
      firstKept,
      messageCount: raw.length,
      tokensBefore: before,
      tokensAfter: 0,
    };
    const replacement = projectHistory(raw, record);
    record.tokensAfter = estimateMessages(replacement);
    if (!fits(record.tokensAfter) || record.tokensAfter >= before)
      throw new Error("Compaction did not reduce context enough to continue safely.");
    signal?.throwIfAborted();
    await persist(record);
    checkpoint = record;
    usageBase = undefined;
    agent.state.messages = replacement;
    return replacement;
  }

  agent.prepareRequest = async ({ context, model }, signal) => {
    const messages = await compact(context.messages, model, false, signal);
    return messages ? { context: { ...context, messages } } : undefined;
  };

  return {
    get busy() {
      return busy || agent.state.isStreaming;
    },
    cancel: () => {
      controller?.abort();
      agent.abort();
    },
    compact: () =>
      exclusive(async () => {
        const model = agent.state.model;
        return Boolean(await compact(agent.state.messages, model, true, controller?.signal));
      }),
    prompt: (text) =>
      exclusive(async () => {
        if (writeFailure) throw writeFailure;
        const unsubscribe = agent.subscribe(async (event) => {
          if (event.type !== "message_end" || writeFailure) return;
          try {
            await persist({ type: "message", message: event.message });
            raw.push(event.message);
            const model = agent.state.model;
            const message = event.message;
            if (
              model &&
              message.role === "assistant" &&
              message.stopReason !== "error" &&
              message.stopReason !== "aborted"
            ) {
              const { input, output, cacheRead, cacheWrite } = message.usage;
              const tokens = input + output + cacheRead + cacheWrite;
              if (input + cacheRead + cacheWrite > 0 && tokens > 0)
                usageBase = { messages: [...agent.state.messages], model: modelKey(model), tokens };
            }
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
        raw = [...baseline];
        checkpoint = undefined;
        usageBase = undefined;
      }),
    list: () =>
      exclusive(async () => {
        const sessions: SessionSummary[] = [];
        for (const name of await readdir(directory)) {
          if (!name.endsWith(".jsonl") || !sessionId.test(name.slice(0, -6))) continue;
          const id = name.slice(0, -6);
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

function modelKey(model: Model<Api>): string {
  return JSON.stringify([
    model.provider,
    model.id,
    model.api,
    model.baseUrl,
    model.contextWindow,
    model.maxTokens,
  ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCompaction(
  value: Record<string, unknown>,
  count: number,
): value is Record<string, unknown> & CompactionRecord {
  return (
    value.type === "compaction" &&
    typeof value.summary === "string" &&
    value.summary.trim().length > 0 &&
    typeof value.timestamp === "number" &&
    Number.isFinite(value.timestamp) &&
    typeof value.firstKept === "number" &&
    Number.isSafeInteger(value.firstKept) &&
    value.firstKept >= 2 &&
    value.firstKept <= count + 1 &&
    value.messageCount === count &&
    typeof value.tokensBefore === "number" &&
    Number.isFinite(value.tokensBefore) &&
    value.tokensBefore > 0 &&
    typeof value.tokensAfter === "number" &&
    Number.isFinite(value.tokensAfter) &&
    value.tokensAfter >= 0 &&
    isRecord(value.usage) &&
    ["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every(
      (key) =>
        typeof value.usage === "object" &&
        value.usage !== null &&
        key in value.usage &&
        typeof Reflect.get(value.usage, key) === "number" &&
        Number.isFinite(Reflect.get(value.usage, key)),
    )
  );
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
