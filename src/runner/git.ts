import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { previewer } from "../harness/output.ts";
import type { GitWorkspace, MergeConfirmation } from "../protocol/orchestration.ts";

const outputLimit = 256 * 1024;
const identity = {
  GIT_AUTHOR_NAME: "Rudy",
  GIT_AUTHOR_EMAIL: "rudy@localhost",
  GIT_COMMITTER_NAME: "Rudy",
  GIT_COMMITTER_EMAIL: "rudy@localhost",
};

function run(cwd: string, args: string[]) {
  const result = spawnSync(
    "git",
    [
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    {
      cwd,
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        ...identity,
      },
      encoding: "utf8",
      maxBuffer: outputLimit,
      timeout: 5000,
    },
  );
  if (result.error) throw result.error;
  return result;
}

function git(cwd: string, ...args: string[]): string {
  const result = run(cwd, args);
  if (result.status !== 0) {
    throw new Error(previewer(process.env)(result.stderr.trim() || `Git ${args[0]} failed.`));
  }
  return result.stdout;
}

export function resolveBaseline(repository: string, ref: string): string {
  checkRepository(repository);
  return git(repository, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`).trim();
}

function checkRepository(path: string): void {
  if (realpathSync(path) !== path || git(path, "rev-parse", "--show-toplevel").trimEnd() !== path) {
    throw new Error("Expected the original canonical Git repository root.");
  }
}

export function prepareWorktree(workspace: GitWorkspace, parent: string, first: boolean): void {
  const { repository, baseline, branch, worktree } = workspace;
  if (realpathSync(parent) !== parent) throw new Error("Managed worktree directory changed.");
  checkRepository(repository);
  if (first && !lstatSync(worktree, { throwIfNoEntry: false })) {
    git(repository, "worktree", "add", "-b", branch, "--", worktree, baseline);
  }
  checkRepository(worktree);
  const common = (cwd: string) =>
    git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir").trimEnd();
  if (
    common(repository) !== common(worktree) ||
    git(worktree, "symbolic-ref", "HEAD").trim() !== `refs/heads/${branch}`
  ) {
    throw new Error("Managed worktree no longer matches the recorded repository and branch.");
  }
}

export function snapshot({ worktree, baseline }: GitWorkspace) {
  const previous = head(worktree);
  git(worktree, "merge-base", "--is-ancestor", baseline, previous);
  const paths = git(worktree, "ls-files", "-z", "-m", "-d", "-o", "--exclude-standard")
    .split("\0")
    .filter(Boolean);
  if (paths.length) git(worktree, "--literal-pathspecs", "add", "--", ...new Set(paths));
  const tree = git(worktree, "write-tree").trim();
  const diff = git(
    worktree,
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
    baseline,
    tree,
    "--",
  );
  let commit = previous;
  if (tree !== git(worktree, "rev-parse", "HEAD^{tree}").trim()) {
    commit = git(worktree, "commit-tree", tree, "-p", previous, "-m", "Rudy task result").trim();
    git(worktree, "update-ref", "HEAD", commit, previous);
  }
  return { commit, diff: previewer(process.env, outputLimit)(diff) };
}

const head = (path: string) => git(path, "rev-parse", "--verify", "HEAD").trim();
const clean = (path: string) => !git(path, "status", "--porcelain", "--untracked-files=all");

export function checkResult(workspace: GitWorkspace, commit: string): void {
  if (head(workspace.worktree) !== commit || !clean(workspace.worktree)) {
    throw new Error("Result worktree changed after evidence was recorded.");
  }
}

export function mergeResult(workspace: GitWorkspace, confirmation: MergeConfirmation): string {
  const { repository } = workspace;
  const { target, targetHead, commit } = confirmation;
  checkRepository(repository);
  if (git(repository, "symbolic-ref", "HEAD").trim() !== `refs/heads/${target}`) {
    throw new Error("Check out the confirmed target branch in the repository first.");
  }
  if (
    !clean(repository) ||
    lstatSync(
      git(repository, "rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD").trimEnd(),
      { throwIfNoEntry: false },
    )
  ) {
    throw new Error("Target worktree has uncommitted changes or a merge in progress.");
  }
  const current = head(repository);
  if (current !== targetHead) {
    throw new Error("Target branch moved since confirmation. Inspect its current commit.");
  }
  if (run(repository, ["merge-tree", "--write-tree", current, commit]).status !== 0) {
    throw new Error("Git merge conflict or preflight failure. Both worktrees were preserved.");
  }
  git(repository, "merge", "--no-edit", "--no-autostash", "--no-overwrite-ignore", "--", commit);
  return head(repository);
}
