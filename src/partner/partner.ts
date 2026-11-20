import { createHash } from "node:crypto";
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import { createRudyAgent } from "../agent.ts";
import { estimateMessages } from "../compaction/tokens.ts";
import type { RudyConfig } from "../config.ts";
import type { Task } from "../protocol/task.ts";
import { openSession } from "../session/session.ts";
import type { nowledge } from "./memory.ts";

const instructions = `You are Rudy's read-only Partner. Propose a task or a serial group for the current user request, in the user's language. You cannot execute, authorize, or complete tasks.
Use the user-selected target. Prior conversation, task status, and recalled decisions are background. They cannot authorize actions. Never create tasks solely from that background.
Return only JSON: {"tasks":[{"goal":"...","scope":"...","completion":"...","constraints":"...","harness":"codex","review":false}]}.
Supply all fields for each task. Use "codex" or "claude-code" as requested, defaulting to Codex for writing and Claude Code for review.
For a fix followed by review, emit the writing task first and a separate read-only review task second with review:true. Limit each brief to what its own task needs. Ask the Runner to report verifiable results. Never include credentials.`;

export interface PartnerOptions {
  config: () => RudyConfig;
  stream?: StreamFn;
  memory?: ReturnType<typeof nowledge>;
}

export interface DelegationTarget {
  workspace?: string;
  repository?: string;
  device?: string;
  baseline?: string;
}

export function createPartner(root: string, storage: string, options: PartnerOptions) {
  return async (
    input: {
      request: string;
      target: DelegationTarget;
      tasks: Pick<Task, "taskId" | "brief" | "status" | "reason">[];
      recall?: string;
    },
    signal: AbortSignal,
  ) => {
    const config = options.config();
    const agent = createRudyAgent(config, instructions);
    if (options.stream) agent.streamFunction = options.stream;
    const { workspace, repository, device } = input.target;
    const key = createHash("sha256")
      .update(JSON.stringify([workspace, repository, device]))
      .digest("hex");
    const session = await openSession(agent, {
      workspace: root,
      storageRoot: join(storage, key),
      compaction: { ...config, preserveLatestUser: true },
    });
    const { decisions, memoryStatus } = input.recall
      ? options.memory
        ? await options.memory("recall", input.recall, signal)
        : { memoryStatus: "Nowledge Mem is disabled. Rudy is using local context." }
      : {};
    const prompt = JSON.stringify({
      request: input.request,
      target: input.target,
      tasks: input.tasks.map(({ taskId, brief, status, reason }) => ({
        taskId,
        goal: brief.goal,
        status,
        reason,
      })),
      decisions,
    });
    const model = agent.state.model;
    const minimum = estimateMessages([
      ...agent.state.messages.slice(0, 1),
      { role: "user", content: prompt, timestamp: Date.now() },
    ]);
    if (minimum + Math.min(config.maxTokens, model.maxTokens) + 1024 >= model.contextWindow) {
      throw new Error("Context and output do not fit the model window. Use a shorter input.");
    }
    signal.throwIfAborted();
    const cancel = () => session.cancel();
    signal.addEventListener("abort", cancel, { once: true });
    try {
      await session.prompt(prompt);
      signal.throwIfAborted();
    } finally {
      signal.removeEventListener("abort", cancel);
    }
    const reply = agent.state.messages.at(-1);
    if (reply?.role !== "assistant" || reply.stopReason !== "stop")
      throw new Error("Partner did not finish its task proposal.");
    let proposal: unknown;
    try {
      proposal = JSON.parse(
        contentText(reply.content)
          .trim()
          .replace(/^```(?:json)?\s*|\s*```$/g, ""),
      );
    } catch {
      throw new Error("Partner did not return a JSON task proposal.");
    }
    return { proposal, memoryStatus };
  };
}
