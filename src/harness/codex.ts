import { spawn } from "node:child_process";
import type { Brief, EventData } from "../protocol/task.ts";
import { readLines } from "./lines.ts";
import { codexEnvironment, previewer } from "./output.ts";

export type Progress = Extract<EventData, { type: "execution.session" | "execution.progress" }>;

export function runCodex(
  executable: string,
  brief: Brief,
  signal: AbortSignal,
  report: (event: Progress) => void,
): Promise<string> {
  const safe = previewer(process.env);
  const filesystem = new Map([[":minimal", "read"]]);
  if (process.platform === "darwin") {
    // Seatbelt grants access to these system temp roots as part of its runtime baseline.
    filesystem.set("/private/tmp", "deny");
    filesystem.set("/private/var/tmp", "deny");
  }
  filesystem.set(brief.workspace, "write");
  const permissions = Array.from(
    filesystem,
    ([path, access]) => `${JSON.stringify(path)}="${access}"`,
  ).join(",");
  return new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      [
        "-a",
        "never",
        "exec",
        "--json",
        "--color",
        "never",
        "--skip-git-repo-check",
        "--ignore-user-config",
        "-c",
        'default_permissions="rudy"',
        "-c",
        `permissions.rudy.filesystem={${permissions}}`,
        "-c",
        "permissions.rudy.network.enabled=false",
        "-c",
        "allow_login_shell=false",
        "-c",
        'shell_environment_policy={inherit="none",set={PATH="/usr/bin:/bin:/usr/sbin:/sbin"}}',
        "-c",
        'web_search="disabled"',
        "-c",
        "features.apps=false",
        "-c",
        "features.plugins=false",
        "--cd",
        brief.workspace,
        "-",
      ],
      {
        cwd: brief.workspace,
        detached: process.platform !== "win32",
        env: codexEnvironment(process.env),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let spawnError: Error | undefined;
    let diagnostic: string | undefined;
    let failure: string | undefined;
    let nativeSessionId: string | undefined;
    let completed = false;
    let result = "";
    let killTimer: NodeJS.Timeout | undefined;
    let timedOut = false;
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
          failure = "Could not signal the Codex process group.";
        }
      }
    }

    function stop(): void {
      if (killTimer) return;
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 2_000);
    }

    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    child.on("error", (error) => {
      spawnError = error;
    });
    // An executable that exits during startup may close stdin before reading the brief.
    child.stdin.on("error", () => {});
    child.stdin.end(
      [
        `Goal: ${brief.goal}`,
        `Workspace: ${brief.workspace}`,
        `Completion conditions: ${brief.completion}`,
        brief.scope && `Scope: ${brief.scope}`,
        brief.constraints && `Constraints: ${brief.constraints}`,
      ]
        .filter(Boolean)
        .join("\n"),
    );

    readLines(child.stderr, (line) => {
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
      if (!value || typeof value !== "object" || !("type" in value)) return;
      if (
        value.type === "thread.started" &&
        !nativeSessionId &&
        "thread_id" in value &&
        typeof value.thread_id === "string" &&
        /^[\w-]{1,128}$/.test(value.thread_id)
      ) {
        clearTimeout(startup);
        nativeSessionId = value.thread_id;
        report({ type: "execution.session", nativeSessionId: safe(nativeSessionId) });
      } else if (
        value.type === "item.completed" &&
        "item" in value &&
        value.item &&
        typeof value.item === "object" &&
        "type" in value.item
      ) {
        if (
          value.item.type === "agent_message" &&
          "text" in value.item &&
          typeof value.item.text === "string"
        ) {
          result = safe(value.item.text);
          report({ type: "execution.progress", message: result });
        } else if (value.item.type === "command_execution" || value.item.type === "file_change") {
          report({
            type: "execution.progress",
            message:
              value.item.type === "file_change"
                ? "Codex changed files."
                : "Codex finished a command.",
          });
        }
      } else if (value.type === "turn.completed") {
        completed = true;
      } else if (
        value.type === "turn.failed" &&
        "error" in value &&
        value.error &&
        typeof value.error === "object" &&
        "message" in value.error &&
        typeof value.error.message === "string"
      ) {
        failure = safe(value.error.message);
      } else if (
        value.type === "error" &&
        "message" in value &&
        typeof value.message === "string"
      ) {
        diagnostic = safe(value.message);
      }
    });

    child.once("close", (code, exitSignal) => {
      clearTimeout(startup);
      signal.removeEventListener("abort", stop);
      clearTimeout(killTimer);
      if (killTimer) kill("SIGKILL");
      if (spawnError) reject(new Error(`Could not start Codex: ${safe(spawnError.message)}`));
      else if (timedOut) reject(new Error("Codex did not report a session within 30 seconds."));
      else if (failure) reject(new Error(`Codex failed: ${failure}`));
      else if (code !== 0 || !nativeSessionId || !completed) {
        const state = exitSignal ?? `exit ${code}`;
        const reason = diagnostic ?? "No completed Codex session and turn were reported.";
        reject(new Error(`Codex exited without completing the task (${state}): ${reason}`));
      } else resolve(result);
    });
  });
}
