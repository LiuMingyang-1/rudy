import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { harnessEnvironment } from "./output.ts";
import { type HarnessEvent, type RunHarness, runProcess } from "./process.ts";

export function claude(executable: string): RunHarness {
  return async (turn, signal, report) => {
    const project = join(turn.workspace, ".claude");
    const skills =
      !turn.readOnly &&
      lstatSync(project, { throwIfNoEntry: false })?.isDirectory() &&
      lstatSync(join(project, "skills"), { throwIfNoEntry: false })?.isDirectory() &&
      !readdirSync(project, { recursive: true, withFileTypes: true }).some((entry) =>
        entry.isSymbolicLink(),
      );
    return runProcess(
      {
        executable,
        name: "Claude Code",
        args: [
          "--print",
          "--output-format",
          "stream-json",
          "--verbose",
          "--restricted",
          "--strict-mcp-config",
          "--no-chrome",
          "--permission-mode",
          turn.readOnly ? "dontAsk" : "acceptEdits",
          ...(turn.readOnly
            ? ["--safe-mode", "--tools", "Read,Glob,Grep"]
            : [
                // Restricted mode discovers instructions from an explicit working directory
                // and project skills from an explicit plugin directory.
                "--add-dir",
                turn.workspace,
                "--settings",
                JSON.stringify({ disableAllHooks: true, disableSkillShellExecution: true }),
                "--tools",
                "Read,Glob,Grep,Edit,Write,Skill",
                ...(skills ? ["--plugin-dir", project] : []),
              ]),
          "--permission-prompts",
          "none",
          ...(turn.sessionId ? ["--resume", turn.sessionId] : []),
        ],
        env: {
          ...harnessEnvironment(process.env, ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]),
          ...(!turn.readOnly && { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" }),
        },
        decode,
        missingSession: /no conversation found with session id/i,
      },
      turn,
      signal,
      report,
    );
  };
}

function decode(value: Record<string, unknown>): HarnessEvent | undefined {
  if (value.type === "system" && value.subtype === "init" && typeof value.session_id === "string") {
    return { type: "session", text: value.session_id };
  }
  if (
    value.type === "assistant" &&
    value.message &&
    typeof value.message === "object" &&
    "content" in value.message &&
    Array.isArray(value.message.content)
  ) {
    const text = value.message.content
      .flatMap((block: unknown) =>
        block &&
        typeof block === "object" &&
        "type" in block &&
        block.type === "text" &&
        "text" in block &&
        typeof block.text === "string"
          ? [block.text]
          : [],
      )
      .join("\n");
    if (text) return { type: "message", text };
  }
  if (value.type === "result") {
    if (
      value.subtype === "success" &&
      value.is_error === false &&
      typeof value.result === "string"
    ) {
      return { type: "complete", text: value.result };
    }
    const errors = Array.isArray(value.errors)
      ? value.errors.filter((error: unknown) => typeof error === "string").join("\n")
      : value.result;
    return {
      type: "failure",
      text: typeof errors === "string" && errors ? errors : "Turn failed.",
    };
  }
}
