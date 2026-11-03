import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

const maxEntries = 50;
const fragmentBudget = 12000;
const pageLimit = 16000;

export function createHistoryTool(view: {
  messages(): AgentMessage[];
  firstKept(): number | undefined;
  sessionId(): string;
}): AgentTool {
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
      const raw = view.messages();
      const current = view.sessionId();
      let index = (view.firstKept() ?? raw.length + 1) - 2;
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
      let remaining = fragmentBudget;
      while (index >= 0 && entries.length < maxEntries && remaining > 0) {
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
          }).length > pageLimit
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
  return historyTool;
}
