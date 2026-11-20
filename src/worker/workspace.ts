import { join } from "node:path";
import type { GitWorkspace } from "../protocol/orchestration.ts";
import type { Task } from "../protocol/task.ts";
import { resolveBaseline } from "../runner/git.ts";
import { contains, validateWorkspace } from "../runner/workspace.ts";

export async function workerRepository(
  name: string,
  root: string,
  dataDir: string,
  repositories: ReadonlyMap<string, string>,
): Promise<string> {
  const configured = repositories.get(name);
  if (!configured) throw new Error("Repository is not configured on this device.");
  const repository = await validateWorkspace(root, configured);
  if (repository !== configured || contains(repository, dataDir) || contains(dataDir, repository))
    throw new Error("Configured repository moved or overlaps the Worker data directory.");
  return repository;
}

export async function workerTask(
  task: Task,
  root: string,
  dataDir: string,
  worktrees: string,
  repositories: ReadonlyMap<string, string>,
): Promise<Task> {
  const remote = task.remote;
  if (!remote) throw new Error("Missing Worker repository.");
  const repository = await workerRepository(remote.repository, root, dataDir, repositories);
  if (remote.workspace && remote.workspace !== repository)
    throw new Error("The original execution workspace is unavailable.");
  let git: GitWorkspace | undefined;
  if (remote.baseline || task.git) {
    const id = task.review ? task.git?.branch.replace(/^rudy\//, "") : task.taskId;
    if (!id || !/^[\w-]{1,128}$/.test(id)) throw new Error("Invalid worktree task ID.");
    const baseline = task.git?.baseline ?? remote.baseline ?? "HEAD";
    git = {
      device: remote.device,
      repository,
      baseline: resolveBaseline(repository, baseline),
      branch: `rudy/${id}`,
      worktree: join(worktrees, id),
    };
    if (
      task.git &&
      (task.git.repository !== repository ||
        task.git.worktree !== git.worktree ||
        task.git.baseline !== git.baseline ||
        task.git.branch !== git.branch)
    )
      throw new Error("The original execution workspace is unavailable.");
  }
  return { ...task, brief: { ...task.brief, workspace: repository }, git };
}
