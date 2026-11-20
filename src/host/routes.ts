import type { IncomingMessage, ServerResponse } from "node:http";
import { parseEventCursor } from "../protocol/task.ts";
import type { LocalRunner } from "../runner/local.ts";
import type { TaskStore } from "../store/tasks/store.ts";
import type { Orchestration } from "./orchestration.ts";
import type { partnerRoutes } from "./partner.ts";
import { object, RequestError, readBody } from "./requests.ts";

export const taskRoute = /^\/tasks\/([\w-]{1,128})(?:\/(events|stop|pause|resume|merge))?$/;

export function json(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(data));
}

export function routes(
  store: TaskStore,
  runner: LocalRunner,
  orchestration: Orchestration,
  partner: ReturnType<typeof partnerRoutes>,
) {
  return async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> => {
    try {
      if (url.pathname === "/tasks" && request.method === "GET") {
        return json(response, 200, store.list());
      }
      if (request.method === "POST") {
        if (url.pathname === "/delegate" || url.pathname === "/remember") {
          return json(response, 201, await partner.handle(url.pathname, request, response));
        }
        if (url.pathname === "/tasks" || url.pathname === "/groups") {
          const body = await readBody(request);
          const group = url.pathname === "/groups";
          const tasks = await orchestration.createTasks(group ? object(body).tasks : [body], group);
          return json(response, 201, group ? tasks : tasks[0]);
        }
      }
      const handled = await orchestration.handle(request, url);
      if (handled) return json(response, handled.status, handled.data);
      const match = taskRoute.exec(url.pathname);
      const task = match && store.get(match[1]);
      if (!task) throw new RequestError(404, "Task or route not found.");
      if (request.method === "GET" && !match[2]) {
        return json(response, 200, {
          task,
          executions: store.executions(task.taskId),
          checkpoint: store.checkpoint(task.taskId),
          evidence: store.result(task.taskId)?.evidence,
        });
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
      if (request.method === "POST" && match[2] === "merge") {
        return json(response, 200, await orchestration.merge(request, task.taskId));
      }
      if (request.method === "POST" && ["stop", "pause", "resume"].includes(match[2])) {
        if (runner.unavailable)
          throw new RequestError(503, "Host cannot accept execution requests.");
        const action = match[2];
        const harness = url.searchParams.get("harness") ?? task.harness;
        if (harness !== "codex" && harness !== "claude-code") {
          throw new RequestError(400, "Choose codex or claude-code.");
        }
        let accepted: boolean;
        try {
          accepted =
            action === "resume"
              ? store.requeue(task.taskId, harness)
              : runner.stop(task, action === "pause");
        } catch (error) {
          runner.storageFailed();
          throw error;
        }
        if (accepted) {
          if (action === "resume") runner.dispatch();
          return json(response, 202, { taskId: task.taskId });
        }
        if (action === "resume") {
          throw new RequestError(
            409,
            task.reason ?? "The previous execution must stop before resuming or switching.",
          );
        }
        throw new RequestError(409, `Cannot ${action} a task with status "${task.status}".`);
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
