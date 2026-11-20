import type { Brief, Harness, Task } from "./task.ts";

export interface GitWorkspace {
  device: string;
  repository: string;
  baseline: string;
  branch: string;
  worktree: string;
}

export interface TaskPlan {
  brief: Brief;
  harness: Harness;
  baseline?: string;
  remote?: Task["remote"];
  review?: boolean;
  waitUntil?: number;
}

export interface CommandResult {
  command: string;
  exitCode: number;
}

export interface GitEvidence {
  commit: string;
  diff: string;
  commands: CommandResult[];
  upstreamExecutionId?: string;
}

export interface MergeConfirmation {
  commit: string;
  target: string;
  targetHead: string;
}
