import { stdout } from "node:process";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { RudyConfig } from "../config.ts";
import type { SessionSummary } from "../session/session.ts";

export function printHelp(): void {
  console.log(
    'Usage: npm start [-- "your task"]\n\nChat commands: /reset, /resume, /resume <number>, /exit\nConfigure .env using .env.example.',
  );
}

export function printWelcome(config: RudyConfig): void {
  console.log(
    `Rudy | ${config.provider}/${config.model}\nWorkspace: ${config.workspace}\n/reset starts a new conversation; /resume lists conversations; /exit quits.`,
  );
}

export function printAgentEvent(event: AgentEvent): void {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    stdout.write(event.assistantMessageEvent.delta);
  }
  if (event.type === "tool_execution_start") console.error(`\n[${event.toolName}]`);
  if (event.type === "tool_execution_update") {
    const content = event.partialResult?.content;
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item.type === "text") console.error(`[${event.toolName}] ${item.text}`);
      }
    }
  }
}

export function printSessions(sessions: SessionSummary[]): void {
  if (!sessions.length) {
    console.log("No conversations to resume.");
    return;
  }
  for (const [index, session] of sessions.entries()) {
    const time = new Date(session.timestamp);
    const date = `${time.getFullYear()}-${String(time.getMonth() + 1).padStart(2, "0")}-${String(time.getDate()).padStart(2, "0")}`;
    const clock = `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
    console.log(`${index + 1}  ${date} ${clock}`);
  }
}

export function printStatus(action: "reset" | "resume"): void {
  console.log(
    action === "reset"
      ? "Started a new conversation. Previous conversations are available via /resume."
      : "Conversation resumed.",
  );
}

export function printReplyEnd(): void {
  stdout.write("\n");
}

export function printError(error: unknown): void {
  console.error(error instanceof Error ? error.message : String(error));
}
