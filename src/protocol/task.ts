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

export type Status = "queued" | "running" | "waiting" | "succeeded" | "failed" | "canceled";
export type Outcome = Extract<Status, "succeeded" | "failed" | "canceled">;

export interface Task {
  taskId: string;
  brief: Brief;
  status: Status;
  reason: string | null;
  createdAt: string;
}

export interface Execution {
  executionId: string;
  taskId: string;
  nativeSessionId: string | null;
  status: Exclude<Status, "queued">;
  reason: string | null;
  result: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface TaskDetail {
  task: Task;
  executions: Execution[];
}

export type EventData =
  | { type: "task.queued" }
  | { type: "execution.started" }
  | { type: "execution.session"; nativeSessionId: string }
  | { type: "execution.progress"; message: string }
  | { type: "execution.finished"; status: Outcome; reason: string | null; result: string | null }
  | { type: "task.waiting" | "task.canceled"; reason: string };

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
