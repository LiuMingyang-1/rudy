import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { Checkpoint } from "../compaction/checkpoint.ts";
import type { CompactionResult } from "../compaction/compact.ts";

export interface CompactionRecord extends Checkpoint {
  type: "compaction";
  messageCount: number;
  tokensBefore: number;
  tokensAfter: number;
  usage: Usage;
}

export function toRecord(
  result: CompactionResult,
  raw: AgentMessage[],
  previous?: CompactionRecord,
): CompactionRecord {
  const record: CompactionRecord = {
    type: "compaction",
    summary: result.summary,
    usage: result.usage,
    timestamp: result.timestamp,
    firstKept: result.firstKept,
    messageCount: raw.length,
    tokensBefore: result.tokensBefore,
    tokensAfter: result.tokensAfter,
  };
  if (!validCheckpoint(record, raw, previous))
    throw new Error("Compaction produced an invalid checkpoint.");
  return record;
}

export const sessionId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCompaction(
  value: Record<string, unknown>,
  count: number,
): value is Record<string, unknown> & CompactionRecord {
  if (!isRecord(value.usage)) return false;
  const usage = value.usage;
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
    ["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every(
      (key) => typeof usage[key] === "number" && Number.isFinite(usage[key]),
    )
  );
}

export function validCheckpoint(
  value: unknown,
  messages: AgentMessage[],
  previous?: CompactionRecord,
): value is Record<string, unknown> & CompactionRecord {
  return (
    isRecord(value) &&
    isCompaction(value, messages.length) &&
    messages[value.firstKept - 1]?.role !== "toolResult" &&
    !(previous && value.firstKept < previous.firstKept)
  );
}

/** Validate the replay-critical fields while retaining provider-specific metadata. */
export function isMessage(value: unknown): value is AgentMessage {
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
