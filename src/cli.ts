import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import type { Agent } from "@earendil-works/pi-agent-core";
import { createRudy } from "./agent.ts";
import { loadConfig } from "./config.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--help" || args[0] === "-h") {
    console.log(
      'Usage: npm start [-- "your task"]\n\nChat commands: /reset, /exit\nConfigure .env using .env.example.',
    );
    return;
  }
  const config = loadConfig();
  const agent = await createRudy(config);
  agent.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      stdout.write(event.assistantMessageEvent.delta);
    }
    if (event.type === "tool_execution_start") {
      console.error(`[${event.toolName}]`);
    }
  });

  if (args.length > 0) {
    const cancel = () => agent.abort();
    process.on("SIGINT", cancel);
    try {
      await reply(agent, args.join(" "));
    } finally {
      process.off("SIGINT", cancel);
    }
    return;
  }
  if (!stdin.isTTY) {
    throw new Error('For non-interactive use, pass a task: npm start -- "your task".');
  }

  console.log(
    `Rudy | ${config.provider}/${config.model}\nWorkspace: ${config.workspace}\n/reset clears this conversation; /exit quits.`,
  );
  const input = createInterface({ input: stdin, output: stdout, prompt: "you> " });
  input.on("SIGINT", () => {
    if (agent.state.isStreaming) agent.abort();
    else input.close();
  });
  input.on("close", () => agent.abort());
  try {
    input.prompt();
    for await (const line of input) {
      const text = line.trim();
      if (text === "/exit") break;
      if (text === "/reset") {
        agent.reset();
        console.log("Conversation cleared.");
      } else if (text) {
        try {
          await reply(agent, text);
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
        }
      }
      input.prompt();
    }
  } finally {
    input.close();
  }
}

async function reply(agent: Agent, text: string): Promise<void> {
  await agent.prompt(text);
  stdout.write("\n");
  if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
