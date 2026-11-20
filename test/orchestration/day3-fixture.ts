import { execFileSync } from "node:child_process";
import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { request } from "../../src/client/orchestration-http.ts";
import { readConnection } from "../../src/host/connection.ts";
import { startHost } from "../../src/host/local.ts";
import type { Clock } from "../../src/host/orchestration.ts";
import type { Task, TaskDetail } from "../../src/protocol/task.ts";
import { fixture, ready, waitFor } from "./fixture.ts";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
  }).trimEnd();
}

export async function day3(t: TestContext, clock?: Clock) {
  const f = await fixture(t);
  f.root = await realpath(f.root);
  const claude = join(f.temporary, "fake-review");
  const write = `#!/usr/bin/env node
const fs = require("node:fs");
const prompt = fs.readFileSync(0, "utf8");
const emit = data => console.log(JSON.stringify(data));
if (prompt.includes("reject restriction")) {
  console.error("error: unrecognized option --strict-config");
  process.exit(2);
}
emit({type:"thread.started", thread_id:"write-thread"});
emit({type:"item.completed", item:{type:"agent_message", text:"ready"}});
if (prompt.includes("fail upstream")) process.exit(3);
if (prompt.includes("review in Codex")) {
  require("node:assert/strict").match(process.argv.join(" "), /permissions.rudy.filesystem=.*="read"/);
  require("node:assert/strict").doesNotMatch(process.argv.join(" "), /permissions.rudy.filesystem=.*="write"/);
  emit({type:"turn.completed"});
  return;
}
if (prompt.includes("gated")) {
  const timer = setInterval(() => { if (fs.existsSync("release")) { clearInterval(timer); finish(); } }, 10);
} else finish();
function finish() {
  if (fs.existsSync("release")) fs.unlinkSync("release");
  fs.writeFileSync("file.txt", "task change\\n");
  fs.writeFileSync("new.txt", "untracked change\\n");
  emit({type:"item.completed", item:{type:"command_execution", command:"npm run check", exit_code:0}});
  emit({type:"item.completed", item:{type:"agent_message", text:"Agent report with an open question"}});
  emit({type:"turn.completed"});
}
`;
  const review = `#!/usr/bin/env node
const fs = require("node:fs");
const assert = require("node:assert/strict");
const prompt = fs.readFileSync(0, "utf8");
const emit = data => console.log(JSON.stringify(data));
assert.ok(process.argv.includes("--safe-mode"));
assert.ok(process.argv.includes("--restricted"));
assert.ok(process.argv.includes("--strict-mcp-config"));
assert.equal(process.argv[process.argv.indexOf("--tools") + 1], "Read,Glob,Grep");
assert.equal(process.argv[process.argv.indexOf("--permission-mode") + 1], "dontAsk");
assert.match(prompt, /Upstream task/);
assert.match(prompt, /Runner evidence:.*npm run check/);
assert.match(prompt, /Runner evidence:.*task change/);
assert.match(prompt, /Upstream agent report: Agent report/);
assert.equal(fs.readFileSync("file.txt", "utf8"), "task change\\n");
emit({type:"system", subtype:"init", session_id:"review-thread"});
emit({type:"assistant", message:{content:[{type:"text", text:"ready"}]}});
const finish = () => emit({type:"result", subtype:"success", is_error:false, result:"Reviewed the change."});
if (prompt.includes("hold review")) {
  const marker = ${JSON.stringify(join(f.temporary, "release-review"))};
  const timer = setInterval(() => { if (fs.existsSync(marker)) { clearInterval(timer); finish(); } }, 10);
} else finish();
`;
  await Promise.all([
    writeFile(f.codex, write, { mode: 0o700 }),
    writeFile(claude, review, { mode: 0o700 }),
  ]);
  git(f.root, "init", "-q", "-b", "main");
  git(f.root, "config", "user.name", "Fixture");
  git(f.root, "config", "user.email", "fixture@localhost");
  await writeFile(join(f.root, "file.txt"), "baseline\n");
  git(f.root, "add", "file.txt");
  git(f.root, "commit", "-qm", "baseline");
  const base = git(f.root, "rev-parse", "HEAD");
  const open = async () => {
    const host = await startHost({
      dataDir: f.dataDir,
      workspaceRoot: f.root,
      port: 0,
      codex: f.codex,
      claude,
      clock,
    });
    f.cleanup.push(() => host.close());
    return host;
  };
  const api = (path: string, method?: string, data?: unknown) =>
    request(readConnection(f.dataDir), path, method, data);
  const plan = (goal: string) => ({
    goal,
    completion: "Report the result",
    workspace: f.root,
    baseline: "main",
  });
  const submit = async (goal: string) => (await api("/tasks", "POST", plan(goal))) as Task;
  const show = async (id: string) => (await api(`/tasks/${id}`)) as TaskDetail;
  const state = (id: string, status: Task["status"]) =>
    waitFor(async () => (await show(id)).task.status === status);
  const running = (id: string) => waitFor(() => ready(readConnection(f.dataDir), id));
  return { f, open, api, plan, submit, show, state, running, base };
}

export function fakeClock() {
  let time = Date.UTC(2026, 10, 20);
  let subscribed: (() => void) | undefined;
  return {
    now: () => time,
    subscribe(tick: () => void) {
      subscribed = tick;
      return () => {
        subscribed = undefined;
      };
    },
    advance(ms: number) {
      time += ms;
      subscribed?.();
    },
  };
}
