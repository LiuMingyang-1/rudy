import type { IncomingMessage } from "node:http";
import type { MergeConfirmation, TaskPlan } from "../protocol/orchestration.ts";
import { type Brief, maxBriefField } from "../protocol/task.ts";
import { workerName } from "../protocol/worker.ts";
import { resolveBaseline } from "../runner/git.ts";
import { contains, validateWorkspace } from "../runner/workspace.ts";

export class RequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    if (!Buffer.isBuffer(chunk)) throw new RequestError(400, "Expected a JSON body.");
    size += chunk.length;
    if (size > 64 * 1024) {
      request.resume();
      throw new RequestError(413, "Task brief is too large.");
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError(400, "Expected JSON.");
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RequestError(400, "Expected a JSON object.");
  return value as Record<string, unknown>;
}

function parseBrief(body: Record<string, unknown>): Brief {
  const brief: Brief = { goal: "", workspace: "", completion: "" };
  for (const key of ["goal", "workspace", "completion", "scope", "constraints"] as const) {
    const value = body[key];
    if (value === undefined && (key === "scope" || key === "constraints")) continue;
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.includes("\0") ||
      value.length > maxBriefField
    ) {
      throw new RequestError(
        400,
        `Invalid brief field "${key}". Use 1–${maxBriefField} characters.`,
      );
    }
    brief[key] = value;
  }
  return brief;
}

export async function parsePlan(
  input: unknown,
  root: string,
  dataDir: string,
  previous?: TaskPlan,
  select?: (
    device: string,
    repository: string,
    harness: TaskPlan["harness"],
    baseline?: string,
  ) => Promise<NonNullable<TaskPlan["remote"]>>,
): Promise<TaskPlan> {
  const body = object(input);
  const review = body.review === true;
  const harness = body.harness ?? "codex";
  if (harness !== "codex" && harness !== "claude-code") {
    throw new RequestError(400, "Choose codex or claude-code.");
  }
  if (
    review &&
    ((!previous?.baseline && !previous?.remote?.baseline && !previous?.review) ||
      body.baseline !== undefined)
  ) {
    throw new RequestError(400, "A review must follow a Git task and uses its worktree.");
  }
  const inherited = review ? previous?.remote : undefined;
  const repository = inherited?.repository ?? body.repository;
  const requested = inherited?.device ?? body.device ?? "auto";
  const device = requested === "auto" && repository === undefined ? "local" : requested;
  if (typeof device !== "string" || !workerName.test(device)) {
    throw new RequestError(400, "Invalid device ID.");
  }
  if (
    review &&
    ((body.device !== undefined && body.device !== device) ||
      (body.repository !== undefined && body.repository !== repository))
  ) {
    throw new RequestError(400, "Review must use the upstream execution device and repository.");
  }
  const brief = parseBrief({
    ...body,
    workspace:
      device === "local" ? (review ? previous?.brief.workspace : body.workspace) : repository,
  });
  let baseline: string | undefined;
  let remote: TaskPlan["remote"];
  try {
    if (
      body.baseline !== undefined &&
      (typeof body.baseline !== "string" ||
        !body.baseline.trim() ||
        body.baseline.includes("\0") ||
        body.baseline.length > maxBriefField)
    )
      throw new Error("Expected an explicit Git baseline.");
    if (device !== "local") {
      if (
        !select ||
        typeof repository !== "string" ||
        !workerName.test(repository) ||
        body.workspace !== undefined
      )
        throw new Error(
          "Remote execution requires a Worker repository alias and no workspace path.",
        );
      remote = await select(device, repository, harness, inherited?.baseline ?? body.baseline);
    } else {
      if (repository !== undefined) throw new Error("A repository alias requires a Worker.");
      brief.workspace = await validateWorkspace(root, brief.workspace);
      if (contains(brief.workspace, dataDir) || contains(dataDir, brief.workspace))
        throw new Error("Workspace overlaps the Host data directory.");
      if (body.baseline !== undefined) baseline = resolveBaseline(brief.workspace, body.baseline);
    }
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(400, error instanceof Error ? error.message : "Invalid workspace.");
  }
  const waitUntil = body.waitUntil;
  if (
    waitUntil !== undefined &&
    (typeof waitUntil !== "number" ||
      !Number.isSafeInteger(waitUntil) ||
      !Number.isFinite(new Date(waitUntil).getTime()))
  ) {
    throw new RequestError(400, "Expected a valid absolute wait time in epoch milliseconds.");
  }
  return { brief, harness, baseline, remote, review: review || undefined, waitUntil };
}

export function parseConfirmation(input: unknown): MergeConfirmation {
  const { commit, target, targetHead } = object(input);
  const sha = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
  if (
    typeof commit !== "string" ||
    !sha.test(commit) ||
    typeof targetHead !== "string" ||
    !sha.test(targetHead) ||
    typeof target !== "string" ||
    !target ||
    target.includes("\0")
  ) {
    throw new RequestError(
      400,
      "Confirm the full result commit, checked-out target branch and full target commit.",
    );
  }
  return { commit, target, targetHead };
}
