import type { AgentMessage } from "@earendil-works/pi-agent-core";

export function closeInterrupted(messages: AgentMessage[]): AgentMessage[] {
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
  return [...pending].map(([toolCallId, toolName]) => ({
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text: "Tool execution was interrupted. The tool was not resumed." }],
    isError: true,
    timestamp: Date.now(),
  }));
}
