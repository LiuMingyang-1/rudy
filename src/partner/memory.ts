import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const label = "rudy-decision";

export function nowledge(executable = "nmem") {
  return async (action: "remember" | "recall", text: string, signal: AbortSignal) => {
    try {
      const options = { signal, timeout: 3000, maxBuffer: 64 * 1024 };
      if (action === "remember") {
        const saving = run(
          executable,
          ["memories", "add", "--stdin", "--label", label, "--unit-type", "decision"],
          options,
        );
        saving.child.stdin?.on("error", () => {});
        saving.child.stdin?.end(text);
        await saving;
        return { memoryStatus: "Decision saved." };
      }
      const { stdout } = await run(
        executable,
        ["memories", "search", "--label", label, "--limit", "3", "--", text],
        options,
      );
      return { decisions: stdout.trim().slice(0, 4000) };
    } catch {
      return { memoryStatus: "Nowledge Mem unavailable. Rudy is using local context." };
    }
  };
}
