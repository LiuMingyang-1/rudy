import { harnessEnvironment } from "./output.ts";
import { type HarnessEvent, type RunHarness, runProcess } from "./process.ts";

export function codex(executable: string): RunHarness {
  return (turn, signal, report) => {
    const filesystem = new Map([[":minimal", "read"]]);
    if (process.platform === "darwin") {
      // Seatbelt grants access to these system temp roots as part of its runtime baseline.
      filesystem.set("/private/tmp", "deny");
      filesystem.set("/private/var/tmp", "deny");
    }
    filesystem.set(turn.workspace, turn.readOnly ? "read" : "write");
    const permissions = Array.from(
      filesystem,
      ([path, access]) => `${JSON.stringify(path)}="${access}"`,
    ).join(",");
    return runProcess(
      {
        executable,
        name: "Codex",
        args: [
          "-a",
          "never",
          "exec",
          "--json",
          "--color",
          "never",
          "--skip-git-repo-check",
          "--ignore-user-config",
          ...(turn.readOnly ? ["--strict-config"] : []),
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
          turn.workspace,
          ...(turn.sessionId ? ["resume", turn.sessionId] : []),
          "-",
        ],
        env: harnessEnvironment(process.env, ["CODEX_HOME", "OPENAI_API_KEY", "CODEX_API_KEY"]),
        decode,
        missingSession:
          /no (?:saved session found with id|rollout found for (?:thread|conversation) id)|thread not found/i,
      },
      turn,
      signal,
      report,
    );
  };
}

function decode(value: Record<string, unknown>): HarnessEvent | undefined {
  if (value.type === "thread.started" && typeof value.thread_id === "string") {
    return { type: "session", text: value.thread_id };
  }
  if (value.type === "item.completed" && value.item && typeof value.item === "object") {
    const item = value.item;
    if (
      "type" in item &&
      item.type === "agent_message" &&
      "text" in item &&
      typeof item.text === "string"
    ) {
      return { type: "message", text: item.text };
    }
    if ("type" in item && item.type === "file_change") {
      return { type: "progress", text: "Codex changed files." };
    }
    if ("type" in item && item.type === "command_execution") {
      if (
        "command" in item &&
        typeof item.command === "string" &&
        "exit_code" in item &&
        typeof item.exit_code === "number"
      ) {
        return { type: "command", command: item.command, exitCode: item.exit_code };
      }
      return { type: "progress", text: "Codex finished a command." };
    }
  }
  if (value.type === "turn.completed") return { type: "complete" };
  if (value.type === "error" && typeof value.message === "string") {
    return { type: "diagnostic", text: value.message };
  }
  if (
    value.type === "turn.failed" &&
    value.error &&
    typeof value.error === "object" &&
    "message" in value.error &&
    typeof value.error.message === "string"
  ) {
    return { type: "failure", text: value.error.message };
  }
}
