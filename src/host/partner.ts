import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { previewer } from "../harness/output.ts";
import { createPartner, type DelegationTarget, type PartnerOptions } from "../partner/partner.ts";
import { maxBriefField } from "../protocol/task.ts";
import type { TaskStore } from "../store/tasks/store.ts";
import type { Orchestration } from "./orchestration.ts";
import { object, RequestError, readBody } from "./requests.ts";

function field(value: unknown, name: string, limit = maxBriefField): string | undefined {
  if (value === undefined) return;
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || value.length > limit)
    throw new RequestError(400, `Invalid ${name}. Use 1–${limit} characters.`);
  return value;
}

export function partnerRoutes(
  store: TaskStore,
  orchestration: Orchestration,
  root: string,
  dataDir: string,
  options: PartnerOptions,
) {
  const propose = createPartner(root, join(dataDir, "partner"), options);
  let active: Promise<unknown> | undefined;
  async function handle(path: string, request: IncomingMessage, response: ServerResponse) {
    const body = object(await readBody(request));
    const controller = new AbortController();
    const signal = controller.signal;
    const cancel = () => controller.abort();
    response.once("close", cancel);
    try {
      if (path === "/remember") {
        const decision = field(body.decision, "decision");
        if (!decision) throw new RequestError(400, "Supply the decision to remember.");
        if (!options.memory)
          throw new RequestError(409, "Start the Host with --memory to save decisions.");
        return await options.memory("remember", decision, signal);
      }
      const text = field(body.request, "request", 24_000) ?? "";
      if (!text) throw new RequestError(400, "Supply a delegation request.");
      const target: DelegationTarget = {
        workspace: field(body.workspace, "workspace"),
        repository: field(body.repository, "repository"),
        device: field(body.device, "device"),
        baseline: field(body.baseline, "baseline"),
      };
      const recall = field(body.recall, "recall query");
      const tasks = store
        .list()
        .filter((task) =>
          target.repository
            ? task.remote?.repository === target.repository &&
              (!target.device || target.device === "auto" || task.remote.device === target.device)
            : !task.remote && task.brief.workspace === target.workspace,
        )
        .slice(-3);
      if (active) throw new RequestError(409, "Partner is busy.");
      active = delegate();
      try {
        return await active;
      } finally {
        active = undefined;
      }

      async function delegate() {
        const { proposal, memoryStatus } = await propose(
          { request: text, target, tasks, recall },
          signal,
        ).catch((error: unknown) => {
          const detail =
            error instanceof Error ? previewer(process.env)(error.message) : "Request failed.";
          throw new RequestError(422, `Partner: ${detail}`);
        });
        const members = object(proposal).tasks;
        if (!Array.isArray(members) || !members.length)
          throw new RequestError(422, "Partner did not propose any tasks.");
        const plans = members.map((member: unknown) => {
          const { goal, completion, scope, constraints, review, harness } = object(member);
          if (scope === undefined || constraints === undefined)
            throw new RequestError(422, "Partner's brief is missing scope or constraints.");
          return {
            goal,
            completion,
            scope,
            constraints,
            review,
            harness,
            ...(review === true ? {} : target),
          };
        });
        return {
          tasks: await orchestration.createTasks(plans, plans.length > 1, signal),
          memoryStatus,
        };
      }
    } finally {
      response.off("close", cancel);
    }
  }
  return { handle, idle: () => active?.catch(() => {}) };
}
