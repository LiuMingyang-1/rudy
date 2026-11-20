import { type Checkpoint, checkpointFields } from "../protocol/task.ts";

export const checkpointRequest = [
  "After meaningful progress and in your final response, include a fenced rudy-checkpoint JSON block.",
  `Provide these string fields: ${checkpointFields.join(", ")}.`,
  "Summarize cumulative task progress. Separate confirmed observations from assumptions.",
  "For verification, state what actually ran and its result. Use an empty string for unavailable details.",
].join(" ");

export function readCheckpoint(
  text: string,
  safe: (text: string) => string,
): Checkpoint | undefined {
  const block = /\x60{3}rudy-checkpoint\s*\n([\s\S]*?)\n\x60{3}/.exec(text);
  if (!block) return;
  let value: unknown;
  try {
    value = JSON.parse(block[1]);
  } catch {
    return;
  }
  if (!value || typeof value !== "object") return;
  const checkpoint: Checkpoint = {
    completed: "",
    currentIssues: "",
    files: "",
    verification: "",
    nextSteps: "",
    assumptions: "",
  };
  for (const field of checkpointFields) {
    const content = Object.getOwnPropertyDescriptor(value, field)?.value;
    if (typeof content !== "string") return;
    checkpoint[field] = safe(content);
  }
  return checkpoint;
}
