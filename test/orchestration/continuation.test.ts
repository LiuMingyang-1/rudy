import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { startHost } from "../../src/host/local.ts";
import type { Task, TaskDetail } from "../../src/protocol/task.ts";
import { cli, fixture, submit, waitFor } from "./fixture.ts";

async function setup(t: TestContext, hold = false) {
  const f = await fixture(t);
  const claude = join(f.temporary, "fake-claude");
  execFileSync("git", ["init", "-q", f.root]);
  const mock = `#!/usr/bin/env node
const fs = require("node:fs");
const assert = require("node:assert/strict");
const args = process.argv.slice(2);
const claude = args.includes("--print");
const resume = claude ? "--resume" : "resume";
const sessionId = args.includes(resume) ? args[args.indexOf(resume) + 1] : null;
const prompt = fs.readFileSync(0, "utf8");
const tracePath = ".trace";
const first = !fs.existsSync(tracePath);
fs.appendFileSync(tracePath, JSON.stringify({claude, sessionId, prompt, cwd: process.cwd()}) + "\\n");
if (claude) {
  assert.ok(args.includes("--restricted"));
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(args[args.indexOf("--add-dir") + 1], process.cwd());
  assert.equal(process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD, "1");
  const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
  assert.equal(settings.disableAllHooks, true);
  assert.equal(settings.disableSkillShellExecution, true);
  assert.equal(args[args.indexOf("--tools") + 1], "Read,Glob,Grep,Edit,Write,Skill");
  if (!prompt.includes("Exercise project limits")) {
    assert.equal(args[args.indexOf("--plugin-dir") + 1], process.cwd() + "/.claude");
  } else assert.ok(!args.includes("--plugin-dir"));
  assert.ok(fs.existsSync("codex.txt"));
} else {
  assert.ok(args.includes("--ignore-user-config"));
  assert.equal(args[args.indexOf("--cd") + 1], process.cwd());
}
if (sessionId && fs.existsSync("reject-session")) {
  console.error("No saved session found with ID " + sessionId);
  process.exit(1);
}
const id = sessionId || (claude ? "claude-thread" : first ? "codex-thread" : "fresh-thread");
const emit = (event) => console.log(JSON.stringify(event));
const file = claude ? "claude.txt" : "codex.txt";
if (!first && !claude && fs.existsSync("claude.txt")) {
  assert.equal(fs.readFileSync("claude.txt", "utf8"), "work");
}
fs.writeFileSync(file, "work");
const summary = {
  completed: claude ? "Claude validated Codex work" : "Codex wrote initial change",
  currentIssues: "Pending review", files: file,
  verification: "Fixture verified expected input", nextSteps: "Review the change",
  assumptions: "Production behavior is unverified"
};
const result = "\x60\x60\x60rudy-checkpoint\\n" + JSON.stringify(summary) + "\\n\x60\x60\x60";
if (claude) {
  emit({type:"system", subtype:"init", session_id:id});
  emit({type:"result", subtype:"success", is_error:false, result});
} else {
  emit({type:"thread.started", thread_id:id});
  emit({type:"item.completed", item:{type:"agent_message",text:result}});
  if (first && ${hold}) setInterval(() => {}, 1000);
  else emit({type:"turn.completed"});
}
`;
  await Promise.all([f.codex, claude].map((path) => writeFile(path, mock, { mode: 0o700 })));
  const open = async () => {
    const host = await startHost({
      dataDir: f.dataDir,
      workspaceRoot: f.root,
      port: 0,
      codex: f.codex,
      claude,
    });
    f.cleanup.push(() => host.close());
    return host;
  };
  const trace = async (): Promise<
    {
      claude: boolean;
      sessionId: string | null;
      prompt: string;
      cwd: string;
    }[]
  > =>
    (await readFile(join(f.root, ".trace"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  const current = async (id: string): Promise<TaskDetail> =>
    JSON.parse((await cli(f, "show", id)).stdout);
  return { f, open, trace, current };
}

test("pause, resume, and switch Codex → Claude Code → Codex in the same task and workspace", async (t) => {
  const { f, open, trace, current } = await setup(t, true);
  await mkdir(join(f.root, ".claude", "skills"), { recursive: true });
  const host = await open();
  const { taskId }: Task = JSON.parse((await submit(f, "Preserve the work")).stdout);
  await waitFor(async () => (await current(taskId)).checkpoint !== null);
  await assert.rejects(
    cli(f, "switch", taskId, "--harness", "claude-code"),
    /previous execution must stop/,
  );
  await cli(f, "pause", taskId);
  await cli(f, "tail", taskId);
  assert.equal((await current(taskId)).task.status, "paused");
  await host.close();
  await open();

  await cli(f, "resume", taskId);
  await cli(f, "tail", taskId);
  await cli(f, "switch", taskId, "--harness", "claude-code");
  await cli(f, "tail", taskId);
  const handoff = await current(taskId);
  assert.equal(handoff.checkpoint?.completed, "Claude validated Codex work");
  await cli(f, "switch", taskId, "--harness", "codex");
  const final = await cli(f, "tail", taskId);
  assert.equal(final.stdout.match(/"type":"execution.finished"/g)?.length, 4);

  const detail = await current(taskId);
  assert.equal(detail.task.status, "succeeded");
  assert.equal(detail.task.taskId, taskId);
  assert.equal(new Set(detail.executions.map((entry) => entry.executionId)).size, 4);
  assert.deepEqual(
    detail.executions.map((entry) => entry.harness),
    ["codex", "codex", "claude-code", "codex"],
  );
  assert.deepEqual(
    detail.executions.map((entry) => entry.nativeSessionId),
    ["codex-thread", "codex-thread", "claude-thread", "codex-thread"],
  );
  const calls = await trace();
  assert.deepEqual(
    calls.map(({ sessionId }) => sessionId),
    [null, "codex-thread", null, "codex-thread"],
  );
  assert.ok(calls.every(({ cwd }) => cwd === detail.task.brief.workspace));
  assert.match(calls[2].prompt, /Preserve the work/);
  assert.match(calls[2].prompt, /Codex wrote initial change/);
  assert.match(calls[3].prompt, /Claude validated Codex work/);
  assert.match(calls[3].prompt, /\?\? claude\.txt/);
});

test("Claude omits a project plugin whose skill symlink points outside the workspace", async (t) => {
  const { f, open, current } = await setup(t);
  const external = join(f.temporary, "external");
  await mkdir(external);
  await mkdir(join(f.root, ".claude", "skills"), { recursive: true });
  await symlink(external, join(f.root, ".claude", "skills", "outside"), "dir");
  await open();
  const { taskId }: Task = JSON.parse((await submit(f, "Exercise project limits")).stdout);
  await cli(f, "tail", taskId);
  await cli(f, "switch", taskId, "--harness", "claude-code");
  await cli(f, "tail", taskId);
  assert.equal((await current(taskId)).task.status, "succeeded");
});

test("a rejected native resume starts a new session from the persisted brief and checkpoint", async (t) => {
  const { f, open, trace, current } = await setup(t);
  const host = await open();
  const { taskId }: Task = JSON.parse((await submit(f, "Persist recovery context")).stdout);
  await cli(f, "tail", taskId);
  await host.close();
  await writeFile(join(f.root, "reject-session"), "");
  await open();

  await cli(f, "resume", taskId);
  assert.match((await cli(f, "tail", taskId)).stdout, /Saved session unavailable/);
  const calls = await trace();
  assert.deepEqual(
    calls.map(({ sessionId }) => sessionId),
    [null, "codex-thread", null],
  );
  const resumed = await current(taskId);
  assert.equal(resumed.task.status, "succeeded");
  assert.equal(resumed.executions.length, 2);
  assert.equal(resumed.executions[1].nativeSessionId, "fresh-thread");
  assert.match(calls[2].prompt, /Goal: Persist recovery context/);
  assert.match(calls[2].prompt, /"completed": "Codex wrote initial change"/);
  assert.match(calls[2].prompt, /"currentIssues": "Pending review"/);
  assert.match(calls[2].prompt, /"files": "codex.txt"/);
  assert.match(calls[2].prompt, /"verification": "Fixture verified expected input"/);
  assert.match(calls[2].prompt, /"nextSteps": "Review the change"/);
  assert.match(calls[2].prompt, /"assumptions": "Production behavior is unverified"/);
  assert.match(calls[2].prompt, /\?\? codex\.txt/);
});
