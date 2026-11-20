import type { GitEvidence, GitWorkspace, MergeConfirmation } from "./orchestration.ts";
import type { Checkpoint, Execution, ExecutionUpdate, Harness, Outcome, Task } from "./task.ts";

export const reconnecting = "Reconnecting to the execution device.";
export const waitingDevice = "Waiting for device.";
export const workerName = /^[\w-]{1,128}$/;

export interface WorkerIdentity {
  device: string;
  token: string;
}

export interface Capabilities {
  name: string;
  repositories: string[];
  harnesses: Harness[];
}

export interface ExecutionInput {
  task: Task;
  history: Execution[];
  checkpoint: Checkpoint | null;
  upstream?: {
    executionId: string;
    evidence: GitEvidence;
    result: string | null;
    checkpoint: Checkpoint | null;
  };
}

export interface Finished {
  type: "execution.finished";
  status: Outcome;
  reason: string | null;
  result: string | null;
  evidence?: GitEvidence;
}

export type WorkerEvent =
  | ExecutionUpdate
  | Finished
  | { type: "execution.received" | "execution.started" }
  | { type: "execution.workspace"; workspace: string; git?: GitWorkspace };

export type WorkerMessage =
  | {
      type: "hello";
      device: string;
      capabilities: Capabilities;
      held: { id: string; last: number; acknowledged: number }[];
    }
  | { type: "event"; id: string; seq: number; event: WorkerEvent }
  | { type: "reply"; id: string; value?: string; error?: string };

export type HostMessage =
  | { type: "dispatch"; id: string; input: ExecutionInput }
  | { type: "ack"; id: string; seq: number }
  | { type: "stop"; id: string; pause: boolean }
  | { type: "baseline"; id: string; repository: string; ref: string }
  | { type: "merge"; id: string; task: Task; confirmation: MergeConfirmation };

export const workerPath = "/worker";
