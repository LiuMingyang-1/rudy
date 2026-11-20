import type { IncomingMessage } from "node:http";
import type { TaskPlan } from "../protocol/orchestration.ts";
import { checkResult, mergeResult, prepareWorktree } from "../runner/git.ts";
import type { LocalRunner } from "../runner/local.ts";
import type { RoutineStore } from "../store/routines.ts";
import type { TaskStore } from "../store/tasks/store.ts";
import type { Pairing } from "../worker/pairing.ts";
import type { RemoteRunner } from "../worker/remote/runner.ts";
import { object, parseConfirmation, parsePlan, RequestError, readBody } from "./requests.ts";

export interface Clock {
  now(): number;
  subscribe(tick: () => void): () => void;
}

export const systemClock: Clock = {
  now: Date.now,
  subscribe(tick) {
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  },
};

export function orchestrate(
  store: TaskStore,
  runner: LocalRunner,
  routines: RoutineStore,
  paths: { root: string; dataDir: string; worktrees: string },
  clock: Clock,
  notify: () => void,
  remote: RemoteRunner,
  pairing?: Pairing,
) {
  const plan = (input: unknown, previous?: TaskPlan) =>
    parsePlan(
      input,
      paths.root,
      paths.dataDir,
      previous,
      async (device, repository, harness, baseline) => {
        const selected = device === "auto" ? pairing?.device() : device;
        if (!selected || !remote.supports({ device: selected, repository }, harness))
          throw new RequestError(409, "No connected device matches the repository and harness.");
        return {
          device: selected,
          repository,
          baseline:
            baseline && !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(baseline)
              ? await remote.baseline(selected, repository, baseline)
              : baseline,
        };
      },
    );

  function writable(): void {
    if (runner.unavailable)
      throw new RequestError(503, "Host cannot accept execution or merge requests.");
  }

  function write<T>(operation: () => T): T {
    writable();
    try {
      return operation();
    } catch (error) {
      runner.storageFailed();
      throw error;
    }
  }

  function tick(): void {
    if (runner.unavailable) return;
    try {
      write(() => routines.tick(clock.now()));
      runner.dispatch();
    } catch {
      // write() already stopped executions on storage failure.
    }
  }

  return {
    tick,
    async createTasks(members: unknown, group: boolean, signal?: AbortSignal) {
      writable();
      if (!Array.isArray(members) || !members.length)
        throw new RequestError(400, "Expected a nonempty serial task group.");
      const plans: TaskPlan[] = [];
      for (const member of members) {
        const next = await plan(member, plans.at(-1));
        if (group && !next.baseline && !next.remote?.baseline && !next.review)
          throw new RequestError(
            400,
            "Each writing group member requires an explicit Git baseline.",
          );
        plans.push(next);
      }
      signal?.throwIfAborted();
      const tasks = write(() => store.createChain(plans, paths.worktrees, clock.now()));
      runner.dispatch();
      return tasks;
    },
    async handle(request: IncomingMessage, url: URL) {
      const path = url.pathname;
      if (request.method === "GET" && path === "/devices")
        return { status: 200, data: remote.devices() };
      if (request.method === "GET" && path === "/routines")
        return { status: 200, data: routines.list() };
      if (request.method !== "POST") return;
      if (path === "/devices/pair") {
        if (!pairing)
          throw new RequestError(409, "Start the Host with --worker-port to enable pairing.");
        return { status: 201, data: { code: pairing.issue() } };
      }
      const revoke = /^\/devices\/([\w-]{1,128})\/revoke$/.exec(path);
      if (revoke) {
        if (!write(() => remote.revoke(revoke[1])))
          throw new RequestError(404, "Device not found.");
        return { status: 200, data: { device: revoke[1] } };
      }
      if (path === "/routines") {
        const body = object(await readBody(request));
        const interval = body.interval;
        const now = clock.now();
        if (
          typeof interval !== "number" ||
          !Number.isSafeInteger(interval) ||
          interval < 1 ||
          !Number.isFinite(new Date(now + interval).getTime())
        )
          throw new RequestError(400, "Expected a positive interval in milliseconds.");
        const template = await plan(body.task);
        return { status: 201, data: write(() => routines.create(template, interval, now)) };
      }
      const toggle = /^\/routines\/([\w-]{1,128})\/(pause|resume)$/.exec(path);
      if (toggle) {
        const enabled = toggle[2] === "resume";
        if (!write(() => routines.enable(toggle[1], enabled)))
          throw new RequestError(404, "Routine not found.");
        if (enabled) tick();
        return { status: 200, data: { id: toggle[1], enabled } };
      }
    },
    async merge(request: IncomingMessage, taskId: string) {
      const confirmation = parseConfirmation(await readBody(request));
      writable();
      const task = store.get(taskId);
      const result = store.result(taskId);
      if (
        !task?.git ||
        task.review ||
        task.status !== "succeeded" ||
        result?.evidence.commit !== confirmation.commit
      )
        throw new RequestError(
          409,
          "Confirmation must match the current successful Git task result.",
        );
      if (
        !task.remote &&
        (runner.occupied(task.git.worktree) || runner.occupied(task.git.repository))
      )
        throw new RequestError(409, "An execution still occupies the result or target worktree.");
      for (const review of store
        .list()
        .filter(
          (entry) =>
            entry.review &&
            (entry.after === taskId ||
              (entry.git?.device === task.git?.device &&
                entry.git?.worktree === task.git?.worktree)),
        )) {
        const prior = review.after && store.result(review.after);
        const reviewed = store.result(review.taskId);
        if (
          review.status !== "succeeded" ||
          !prior ||
          reviewed?.evidence.commit !== confirmation.commit ||
          reviewed.evidence.upstreamExecutionId !== prior.executionId
        )
          throw new RequestError(409, "The current result has a pending or outdated review.");
      }
      let head: string;
      try {
        if (task.remote) head = await remote.merge(task, confirmation);
        else {
          prepareWorktree(task.git, paths.worktrees, false);
          checkResult(task.git, confirmation.commit);
          head = mergeResult(task.git, confirmation);
        }
      } catch (error) {
        throw new RequestError(409, error instanceof Error ? error.message : "Git merge failed.");
      }
      write(() => store.record(taskId, { type: "task.merged", confirmation, head }));
      notify();
      return { head };
    },
  };
}

export type Orchestration = ReturnType<typeof orchestrate>;
