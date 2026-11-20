import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { ExecutionUpdate } from "../protocol/task.ts";
import { readCheckpoint } from "./checkpoint.ts";
import { readLines } from "./lines.ts";
import { previewer } from "./output.ts";

export interface Turn {
  workspace: string;
  prompt: string;
  sessionId?: string;
  readOnly?: boolean;
}

export type RunHarness = (
  turn: Turn,
  signal: AbortSignal,
  report: (event: ExecutionUpdate) => void,
) => Promise<string>;

export type HarnessEvent =
  | { type: "session" | "message" | "progress" | "diagnostic" | "failure"; text: string }
  | { type: "command"; command: string; exitCode: number }
  | { type: "complete"; text?: string };

export class SessionUnavailable extends Error {}

interface Command {
  executable: string;
  name: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  decode: (value: Record<string, unknown>) => HarnessEvent | undefined;
  missingSession: RegExp;
}

export function runProcess(
  command: Command,
  turn: Turn,
  signal: AbortSignal,
  report: (event: ExecutionUpdate) => void,
): Promise<string> {
  signal.throwIfAborted();
  const safe = previewer(process.env);
  const { name } = command;
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      cwd: turn.workspace,
      detached: process.platform !== "win32",
      env: command.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let spawnError: Error | undefined;
    let diagnostic: string | undefined;
    let failure: string | undefined;
    let nativeSessionId: string | undefined;
    let completed = false;
    let result = "";
    let lastMessage: string | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let timedOut = false;
    let resumeRejected = false;
    const startup = setTimeout(() => {
      timedOut = true;
      stop();
    }, 30_000);

    function kill(signal: NodeJS.Signals): void {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
          failure = `Could not signal the ${name} process group.`;
        }
      }
    }

    function stop(): void {
      if (killTimer) return;
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 2_000);
    }

    function message(text: string): void {
      lastMessage = text;
      result = safe(text);
      report({ type: "execution.progress", message: result });
      const checkpoint = readCheckpoint(text, safe);
      if (checkpoint) report({ type: "execution.checkpoint", checkpoint });
    }

    signal.addEventListener("abort", stop, { once: true });
    child.on("error", (error) => {
      spawnError = error;
    });
    child.stdin.on("error", () => {});
    if (child.pid && process.platform !== "win32") {
      report({ type: "execution.process", pgid: child.pid });
    }
    child.stdin.end(signal.aborted ? undefined : turn.prompt);

    readLines(child.stderr, (line) => {
      resumeRejected ||= command.missingSession.test(line);
      if (line.trim() && (!diagnostic || /^error[: ]/i.test(line.trim()))) {
        diagnostic = safe(line.trim());
      }
    });

    readLines(child.stdout, (line) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return;
      }
      if (!value || typeof value !== "object") return;
      const event = command.decode(value as Record<string, unknown>);
      if (!event) return;
      switch (event.type) {
        case "session":
          if (nativeSessionId || !/^[\w-]{1,128}$/.test(event.text)) break;
          if (turn.sessionId && event.text !== turn.sessionId) {
            failure = `${name} reported a different session during resume.`;
            stop();
            break;
          }
          clearTimeout(startup);
          nativeSessionId = event.text;
          report({ type: "execution.session", nativeSessionId: safe(event.text) });
          break;
        case "message":
          message(event.text);
          break;
        case "progress":
          report({ type: "execution.progress", message: event.text });
          break;
        case "command":
          report({
            type: "execution.command",
            result: { command: safe(event.command), exitCode: event.exitCode },
          });
          break;
        case "complete":
          completed = true;
          if (event.text !== undefined && event.text !== lastMessage) message(event.text);
          break;
        case "diagnostic":
        case "failure":
          resumeRejected ||= command.missingSession.test(event.text);
          if (event.type === "failure") failure = safe(event.text);
          else diagnostic = safe(event.text);
          break;
      }
    });

    child.once("close", async (code, exitSignal) => {
      clearTimeout(startup);
      signal.removeEventListener("abort", stop);
      clearTimeout(killTimer);
      if (child.pid && process.platform !== "win32") {
        kill("SIGKILL");
        // A child may close its pipes before the rest of its process group stops.
        while (true) {
          try {
            process.kill(-child.pid, 0);
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ESRCH") break;
          }
          await delay(20);
        }
      }
      if (spawnError) reject(new Error(`Could not start ${name}: ${safe(spawnError.message)}`));
      else if (timedOut) reject(new Error(`${name} did not report a session within 30 seconds.`));
      else if (turn.sessionId && !nativeSessionId && resumeRejected && !signal.aborted) {
        reject(new SessionUnavailable(`${name} rejected the saved session.`));
      } else if (failure) reject(new Error(`${name} failed: ${failure}`));
      else if (code !== 0 || !nativeSessionId || !completed) {
        const state = exitSignal ?? `exit ${code}`;
        const reason = diagnostic ?? `No completed ${name} session and turn were reported.`;
        reject(new Error(`${name} exited without completing the task (${state}): ${reason}`));
      } else resolve(result);
    });
  });
}
