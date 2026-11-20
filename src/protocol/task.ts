import type {
  CommandResult,
  GitEvidence,
  GitWorkspace,
  MergeConfirmation,
} from "./orchestration.ts";

export const loopback = "127.0.0.1";
export const eventProtocol = "rudy.events.v1";
export const defaultPort = 4317;
export const maxBriefField = 4096;
export const eventPageSize = 100;

export interface Brief {
  goal: string;
  workspace: string;
  completion: string;
  scope?: string;
  constraints?: string;
}

export type Harness = "codex" | "claude-code";
export type Status =
  | "queued"
  | "running"
  | "waiting"
  | "paused"
  | "succeeded"
  | "failed"
  | "canceled";
export type Outcome = Exclude<Status, "queued" | "running">;

export const checkpointFields = [
  "completed",
  "currentIssues",
  "files",
  "verification",
  "nextSteps",
  "assumptions",
] as const;
export type Checkpoint = Record<(typeof checkpointFields)[number], string>;

export interface Task {
  taskId: string;
  brief: Brief;
  harness: Harness;
  status: Status;
  reason: string | null;
  createdAt: string;
  git?: GitWorkspace;
  remote?: { device: string; repository: string; baseline?: string; workspace?: string };
  review?: boolean;
  after?: string;
  waitUntil?: number;
  routineId?: string;
}

export interface Execution {
  executionId: string;
  taskId: string;
  harness: Harness;
  nativeSessionId: string | null;
  pgid: number | null;
  device: string;
  status: Exclude<Status, "queued">;
  reason: string | null;
  result: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface TaskDetail {
  task: Task;
  executions: Execution[];
  checkpoint: Checkpoint | null;
  evidence?: GitEvidence;
}

export type EventData =
  | { type: "task.queued" }
  | { type: "execution.command"; result: CommandResult }
  | { type: "execution.evidence"; evidence: GitEvidence }
  | { type: "task.merged"; confirmation: MergeConfirmation; head: string }
  | {
      type:
        | "execution.dispatched"
        | "execution.received"
        | "execution.reconnecting"
        | "execution.reconnected";
      device: string;
    }
  | { type: "execution.workspace"; workspace: string; git?: GitWorkspace }
  | { type: "execution.started"; device?: string }
  | { type: "execution.process"; pgid: number }
  | { type: "execution.session"; nativeSessionId: string }
  | { type: "execution.progress"; message: string }
  | { type: "execution.checkpoint"; checkpoint: Checkpoint }
  | { type: "execution.finished"; status: Outcome; reason: string | null; result: string | null }
  | { type: "task.waiting" | "task.canceled"; reason: string };

export type ExecutionUpdate = Extract<
  EventData,
  {
    type:
      | "execution.process"
      | "execution.session"
      | "execution.progress"
      | "execution.checkpoint"
      | "execution.command";
  }
>;

export type TaskEvent = EventData & {
  seq: number;
  taskId: string;
  executionId: string | null;
  at: string;
};

export const eventPath = (taskId: string, after: number) =>
  `/tasks/${taskId}/events?after=${after}`;

export function parseEventCursor(value: string): number {
  const after = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(after)) {
    throw new Error("Expected a nonnegative integer event cursor.");
  }
  return after;
}
