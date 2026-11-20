import type { Task } from "../protocol/task.ts";
import type { TaskStore } from "../store/tasks/store.ts";

export const dependencyWait = "Waiting for task ";
export const timeWait = "Waiting until ";

export function readiness(store: TaskStore, task: Task, now: number) {
  if (task.after) {
    const prior = store.get(task.after);
    const result = store.result(task.after);
    if (prior?.status !== "succeeded" || !result) {
      const state = prior?.status === "succeeded" ? "missing evidence" : prior?.status;
      return { reason: `${dependencyWait}${task.after} to succeed (${state}).` };
    }
    if (task.waitUntil === undefined || task.waitUntil <= now) return { result };
  }
  if (task.waitUntil !== undefined && task.waitUntil > now) {
    return { reason: `${timeWait}${new Date(task.waitUntil).toISOString()}.` };
  }
  return {};
}
