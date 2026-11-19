import type { IncomingMessage, ServerResponse } from "node:http";
import { type Brief, maxBriefField, parseEventCursor } from "../protocol/task.ts";
import type { LocalRunner } from "../runner/local.ts";
import { contains, validateWorkspace } from "../runner/workspace.ts";
import type { TaskStore } from "../store/tasks.ts";

class RequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readBrief(request: IncomingMessage): Promise<Brief> {
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

  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError(400, "Expected a JSON task brief.");
  }
  if (!body || typeof body !== "object") throw new RequestError(400, "Expected a task brief.");
  const brief: Brief = { goal: "", workspace: "", completion: "" };
  for (const key of ["goal", "workspace", "completion", "scope", "constraints"] as const) {
    const value = Object.getOwnPropertyDescriptor(body, key)?.value;
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

export const taskRoute = /^\/tasks\/([\w-]{1,128})(?:\/(events|stop))?$/;

export function json(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(data));
}

export function routes(store: TaskStore, runner: LocalRunner, root: string, dataDir: string) {
  return async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> => {
    try {
      if (url.pathname === "/tasks" && request.method === "GET") {
        return json(response, 200, store.list());
      }
      if (url.pathname === "/tasks" && request.method === "POST") {
        const brief = await readBrief(request);
        try {
          brief.workspace = await validateWorkspace(root, brief.workspace);
          if (contains(brief.workspace, dataDir) || contains(dataDir, brief.workspace)) {
            throw new Error("Workspace overlaps the Host data directory.");
          }
        } catch (error) {
          throw new RequestError(
            400,
            error instanceof Error ? error.message : "Invalid workspace.",
          );
        }
        if (runner.unavailable)
          throw new RequestError(503, "Host cannot accept execution requests.");
        let task: ReturnType<TaskStore["create"]>;
        try {
          task = store.create(brief);
        } catch (error) {
          runner.storageFailed();
          throw error;
        }
        runner.dispatch();
        return json(response, 201, task);
      }
      const match = taskRoute.exec(url.pathname);
      const task = match && store.get(match[1]);
      if (!task) throw new RequestError(404, "Task or route not found.");
      if (request.method === "GET" && !match[2]) {
        return json(response, 200, { task, executions: store.executions(task.taskId) });
      }
      if (request.method === "GET" && match[2] === "events") {
        let after: number;
        try {
          after = parseEventCursor(url.searchParams.get("after") ?? "0");
        } catch (error) {
          throw new RequestError(
            400,
            error instanceof Error ? error.message : "Invalid event cursor.",
          );
        }
        return json(response, 200, store.events(task.taskId, after));
      }
      if (request.method === "POST" && match[2] === "stop") {
        if (runner.unavailable) throw new RequestError(503, "Host cannot accept stop requests.");
        let accepted: boolean;
        try {
          accepted = runner.cancel(task);
        } catch (error) {
          runner.storageFailed();
          throw error;
        }
        if (accepted) return json(response, 202, { taskId: task.taskId });
        throw new RequestError(409, `Task cannot be stopped from status "${task.status}".`);
      }
      throw new RequestError(405, "Method not allowed.");
    } catch (error) {
      if (error instanceof RequestError) json(response, error.status, { error: error.message });
      else
        json(response, 503, {
          error: "Rudy could not access SQLite. Check the Host data directory.",
        });
    }
  };
}
