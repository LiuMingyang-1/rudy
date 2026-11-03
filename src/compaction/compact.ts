import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { type Checkpoint, projectHistory } from "./checkpoint.ts";
import { generateSummary } from "./summary.ts";
import { estimateMessages, recentStart, type UsageBaseline } from "./tokens.ts";

export interface CompactionOptions {
  compactionThreshold?: number;
  compactionKeepRecentTokens?: number;
  compactionMaxTokens?: number;
  maxTokens?: number;
}

export interface CompactionResult extends Checkpoint {
  usage: Usage;
  tokensBefore: number;
  tokensAfter: number;
  replacement: AgentMessage[];
}

export async function compact(input: {
  agent: Agent;
  model: Model<Api>;
  messages: AgentMessage[];
  raw: AgentMessage[];
  checkpoint?: Checkpoint;
  baseline: UsageBaseline;
  options: CompactionOptions;
  manual: boolean;
  signal?: AbortSignal;
}): Promise<CompactionResult | undefined> {
  const { agent, model, messages, raw, checkpoint, baseline, options, manual, signal } = input;
  signal?.throwIfAborted();
  const before = baseline.estimate(messages, model);
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
  const candidate: Checkpoint = {
    summary: result.summary,
    timestamp: Date.now(),
    firstKept,
  };
  const replacement = projectHistory(raw, candidate);
  const tokensAfter = estimateMessages(replacement);
  if (!fits(tokensAfter) || tokensAfter >= before)
    throw new Error("Compaction did not reduce context enough to continue safely.");
  signal?.throwIfAborted();
  return {
    ...candidate,
    usage: result.usage,
    tokensBefore: before,
    tokensAfter,
    replacement,
  };
}
