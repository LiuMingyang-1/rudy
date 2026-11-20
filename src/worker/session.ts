import { previewer } from "../harness/output.ts";
import type { RunHarness } from "../harness/process.ts";
import type { Harness } from "../protocol/task.ts";
import type {
  ExecutionInput,
  HostMessage,
  WorkerEvent,
  WorkerMessage,
} from "../protocol/worker.ts";
import { runExecution } from "../runner/execution.ts";
import { checkResult, mergeResult, prepareWorktree, resolveBaseline } from "../runner/git.ts";
import type { WorkerJournal } from "./journal.ts";
import { workerRepository, workerTask } from "./workspace.ts";

interface Entry {
  id: string;
  abort: AbortController;
  done?: Promise<void>;
}

export function workerSession(options: {
  device: string;
  root: string;
  dataDir: string;
  worktrees: string;
  repositories: ReadonlyMap<string, string>;
  journal: WorkerJournal;
  harnesses: Partial<Record<Harness, RunHarness>>;
  send: (message: WorkerMessage) => void;
  onStorageFailure: () => void;
}) {
  const { root, dataDir, worktrees, repositories, harnesses, device, journal, send } = options;
  let active: Entry | undefined;
  let merging = false;
  let failed = false;
  const safe = previewer(process.env);

  async function execute(id: string, entry: Entry, input: ExecutionInput): Promise<void> {
    let seq = 0;
    let started = false;
    const report = (event: WorkerEvent) => {
      const frame = { type: "event" as const, id, seq: ++seq, event };
      if (failed) return;
      try {
        journal.append(frame);
      } catch {
        failed = true;
        entry.abort.abort("Worker could not save execution events.");
        options.onStorageFailure();
        return;
      }
      send(frame);
    };
    try {
      report({ type: "execution.received" });
      entry.abort.signal.throwIfAborted();
      const run = harnesses[input.task.harness];
      if (!run || input.task.remote?.device !== device)
        throw new Error("Execution does not match this device's capabilities.");
      const task = await workerTask(input.task, root, dataDir, worktrees, repositories);
      report({ type: "execution.workspace", workspace: task.brief.workspace, git: task.git });
      report(
        await runExecution(
          { root, worktrees, run },
          { ...input, task },
          entry.abort.signal,
          (event) => {
            if (!started) {
              started = true;
              report({ type: "execution.started" });
            }
            report(event);
          },
          () => entry.abort.signal.reason === "Worker stopped.",
        ),
      );
    } catch (error) {
      report({
        type: "execution.finished",
        status: "failed",
        reason: safe(String(error)),
        result: null,
      });
    } finally {
      active = undefined;
    }
  }

  async function merge({ id, task, confirmation }: Extract<HostMessage, { type: "merge" }>) {
    try {
      if (active || task.remote?.device !== device)
        throw new Error("The execution device must be idle to merge.");
      const local = await workerTask(task, root, dataDir, worktrees, repositories);
      if (!local.git) throw new Error("Git worktree is unavailable.");
      prepareWorktree(local.git, worktrees, false);
      checkResult(local.git, confirmation.commit);
      const head = mergeResult(local.git, confirmation);
      send({ type: "reply", id, value: head });
    } catch (error) {
      send({ type: "reply", id, error: safe(String(error)) });
    } finally {
      merging = false;
    }
  }

  function replay(id?: string): void {
    for (const held of journal.held(active?.id)) {
      if (id && id !== held.id) continue;
      for (const event of journal.replay(held.id)) send(event);
    }
  }

  return {
    held() {
      return journal.held(active?.id);
    },
    replay,
    receive(message: HostMessage) {
      if (message.type === "baseline") {
        void workerRepository(message.repository, root, dataDir, repositories)
          .then((repository) => resolveBaseline(repository, message.ref))
          .then(
            (value) => send({ type: "reply", id: message.id, value }),
            (error: unknown) => send({ type: "reply", id: message.id, error: safe(String(error)) }),
          );
        return;
      }
      if (message.type === "merge") {
        if (merging) send({ type: "reply", id: message.id, error: "A merge is already running." });
        else {
          merging = true;
          void merge(message);
        }
        return;
      }
      if (message.type === "dispatch") {
        if (!active && !merging && journal.claim(message.id)) {
          const entry: Entry = { id: message.id, abort: new AbortController() };
          active = entry;
          entry.done = execute(message.id, entry, message.input);
        } else {
          replay(message.id);
        }
      } else if (message.type === "ack") {
        journal.acknowledge(message.id, message.seq);
      } else if (message.type === "stop" && active?.id === message.id) {
        active.abort.abort(message.pause ? "Paused by the user." : "Stopped by the user.");
      }
    },
    async stop() {
      active?.abort.abort("Worker stopped.");
      await active?.done;
    },
  };
}
