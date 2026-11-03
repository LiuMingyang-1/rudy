import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { type Checkpoint, projectHistory } from "../compaction/checkpoint.ts";
import { type CompactionOptions, compact } from "../compaction/compact.ts";
import { createUsageBaseline } from "../compaction/tokens.ts";
import { createHistoryTool } from "./history-tool.ts";
import { closeInterrupted } from "./interrupted.ts";
import { type CompactionRecord, toRecord } from "./records.ts";
import { openStore, type SessionSummary } from "./store.ts";

export interface RudySession {
  prompt(text: string): Promise<void>;
  reset(): Promise<void>;
  list(): Promise<SessionSummary[]>;
  resume(id: string): Promise<void>;
  compact(): Promise<boolean>;
  readonly busy: boolean;
  cancel(): void;
}

/** The optional storage root keeps offline tests away from the user's sessions. */
export async function openSession(
  agent: Agent,
  workspace: string,
  storageRoot = join(homedir(), ".rudy", "sessions"),
  options: CompactionOptions = {},
): Promise<RudySession> {
  if (agent.state.isStreaming) throw new Error("Session is busy.");
  const store = await openStore(storageRoot, await realpath(workspace));
  let raw: AgentMessage[] = [];
  let checkpoint: Checkpoint | undefined;
  const usage = createUsageBaseline();
  let controller: AbortController | undefined;
  let busy = false;
  let failure: Error | undefined;
  let current: string;
  const historyTool = createHistoryTool({
    messages: () => raw,
    firstKept: () => checkpoint?.firstKept,
    sessionId: () => current,
  });
  agent.state.tools = [
    ...agent.state.tools.filter((tool) => tool.name !== historyTool.name),
    historyTool,
  ];
  // Materialize tool declarations in the baseline before writing a new session.
  const initialSystem = agent.state.messages[0];
  if (initialSystem?.role === "system") {
    const toolsAdded = agent.state.tools.map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
    agent.state.messages = [{ ...initialSystem, toolsAdded }, ...agent.state.messages.slice(1)];
  }
  const baseline = structuredClone(agent.state.messages);
  function failWrite(): Error {
    failure = new Error("Session write failed. Reopen or reset the session before continuing.");
    agent.abort();
    return failure;
  }
  async function persist(record: object): Promise<void> {
    if (failure) throw failure;
    try {
      await store.append(current, [record]);
    } catch {
      throw failWrite();
    }
  }
  async function restore(id: string): Promise<void> {
    const { messages, compaction } = await store.read(id, true);
    const interrupted = closeInterrupted(messages);
    if (interrupted.length) {
      const records = interrupted.map((message) => ({ type: "message", message }));
      await store.append(id, records);
      messages.push(...interrupted);
    }
    await store.point(id);
    activate(id, projectHistory(messages, compaction), messages, compaction);
  }
  function activate(
    id: string,
    state: AgentMessage[],
    rawMessages: AgentMessage[],
    kept?: Checkpoint,
  ): void {
    agent.reset();
    agent.state.messages = state;
    agent.sessionId = current = id;
    failure = undefined;
    raw = rawMessages;
    checkpoint = kept;
    usage.clear();
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
  async function compacting(
    messages: AgentMessage[],
    model: Model<Api>,
    manual: boolean,
    signal?: AbortSignal,
  ): Promise<AgentMessage[] | undefined> {
    if (failure) throw failure;
    const result = await compact({
      agent,
      model,
      messages,
      raw,
      checkpoint,
      baseline: usage,
      options,
      manual,
      signal,
    });
    if (!result) return;
    const record: CompactionRecord = toRecord(result, raw.length);
    await persist(record);
    checkpoint = record;
    usage.clear();
    agent.state.messages = result.replacement;
    return result.replacement;
  }
  const pointed = await store.readPointer();
  if (pointed === undefined) {
    current = await store.create(baseline);
    raw = [...baseline];
    agent.state.messages = baseline;
    agent.sessionId = current;
  } else {
    await restore(pointed);
  }
  agent.prepareRequest = async ({ context, model }, signal) => {
    const messages = await compacting(context.messages, model, false, signal);
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
        return Boolean(await compacting(agent.state.messages, model, true, controller?.signal));
      }),
    prompt: (text) =>
      exclusive(async () => {
        if (failure) throw failure;
        const unsubscribe = agent.subscribe(async (event) => {
          if (event.type !== "message_end" || failure) return;
          try {
            await persist({ type: "message", message: event.message });
            raw.push(event.message);
            const model = agent.state.model;
            if (model) usage.observe(event.message, agent.state.messages, model);
          } catch {
            failWrite();
          }
        });
        try {
          await agent.prompt(text);
          if (failure) throw failure;
          if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
        } finally {
          unsubscribe();
        }
      }),
    reset: () =>
      exclusive(async () => {
        activate(await store.create(baseline), baseline, [...baseline]);
      }),
    list: () => exclusive(() => store.summaries()),
    resume: (id) => exclusive(() => restore(id)),
  };
}
