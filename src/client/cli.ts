import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { createRudy } from "../agent.ts";
import { loadConfig } from "../config.ts";
import { openSession, type RudySession, type SessionSummary } from "../session/session.ts";
import {
  printAgentEvent,
  printError,
  printHelp,
  printReplyEnd,
  printSessions,
  printStatus,
  printWelcome,
} from "./output.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--help" || args[0] === "-h") {
    printHelp();
    return;
  }
  const config = loadConfig();
  const agent = await createRudy(config);
  agent.subscribe(printAgentEvent);
  if (!args.length && !stdin.isTTY) {
    throw new Error('For non-interactive use, pass a task: npm start -- "your task".');
  }
  const session = await openSession(agent, config.workspace, undefined, config);

  if (args.length > 0) {
    const cancel = () => session.cancel();
    process.on("SIGINT", cancel);
    try {
      await reply(session, args.join(" "));
    } finally {
      process.off("SIGINT", cancel);
    }
    return;
  }
  printWelcome(config);
  let listed: SessionSummary[] = [];
  const input = createInterface({ input: stdin, output: stdout, prompt: "you> " });
  input.on("SIGINT", () => {
    if (session.busy) session.cancel();
    else input.close();
  });
  input.on("close", () => session.cancel());
  // Handle lines when received so busy input is rejected instead of queued by
  // readline's async iterator and executed after the current operation settles.
  let running: Promise<void> = Promise.resolve();
  try {
    input.prompt();
    input.on("line", (line) => {
      if (session.busy) {
        printError(
          new Error("Session is busy. Cancel with Ctrl+C before entering another command."),
        );
        return;
      }
      running = handleLine(line);
    });
    await new Promise<void>((resolve) => input.once("close", resolve));
    await running;
  } finally {
    input.close();
  }

  async function handleLine(line: string): Promise<void> {
    const text = line.trim();
    if (text === "/exit") {
      input.close();
      return;
    }
    try {
      if (text === "/reset") {
        await session.reset();
        listed = [];
        printStatus("reset");
      } else if (text === "/compact") {
        console.log(
          (await session.compact()) ? "Conversation compacted." : "No history to compact.",
        );
      } else if (text === "/resume") {
        listed = [];
        listed = await session.list();
        printSessions(listed);
      } else if (/^\/resume\s/.test(text)) {
        const number = text.slice("/resume".length).trim();
        const selected = /^[1-9]\d*$/.test(number) ? listed[Number(number) - 1] : undefined;
        if (!selected) throw new Error("Run /resume, then use /resume <number> from that list.");
        await session.resume(selected.id);
        printStatus("resume");
      } else if (text) {
        await reply(session, text);
      }
    } catch (error) {
      printError(error);
    }
    input.prompt();
  }
}

async function reply(session: RudySession, text: string): Promise<void> {
  try {
    await session.prompt(text);
  } finally {
    printReplyEnd();
  }
}

main().catch((error: unknown) => {
  printError(error);
  process.exitCode = 1;
});
