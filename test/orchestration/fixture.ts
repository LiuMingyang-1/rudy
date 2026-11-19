import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { request } from "../../src/client/orchestration-http.ts";
import { type Connection, readConnection } from "../../src/host/connection.ts";

const exec = promisify(execFile);

export async function fixture(t: TestContext) {
  const temporary = await mkdtemp(join(tmpdir(), "rudy-orchestration-"));
  const root = join(temporary, "work");
  const dataDir = join(temporary, "data");
  const codex = join(temporary, "fake-codex");
  const cleanup: (() => Promise<unknown>)[] = [];
  t.after(async () => {
    try {
      for (const close of cleanup.reverse()) await close();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
  await mkdir(root);
  await writeFile(
    codex,
    `#!/usr/bin/env node
const fs = require("node:fs");
const prompt = fs.readFileSync(0, "utf8");
if (prompt.includes("invalid args")) {
  console.error("warning: test fixture");
  console.error("error: unexpected argument");
  process.exit(2);
}
if (prompt.includes("silent exit")) process.exit(0);
const emit = (data) => console.log(JSON.stringify(data));
emit({type:"thread.started",thread_id:"native-fixture-thread"});
if (process.env.RUDY_FIXTURE_TOKEN) process.exit(42);
emit({type:"item.completed", item:{type:"agent_message",text:"ready"}});
if (prompt.includes("gated")) {
  setTimeout(() => process.exit(3), 10_000).unref();
  const timer = setInterval(() => {
    if (!fs.existsSync("release")) return;
    clearInterval(timer);
    complete();
  }, 20);
} else complete();
function complete() {
  if (prompt.includes("many messages")) {
    for (let i = 0; i < 115; i++) emit({type:"item.completed",item:{type:"agent_message",text:"step " + i}});
  }
  emit({type:"item.completed",item:{type:"command_execution",aggregated_output:"raw tool output"}});
  emit({type:"item.completed",item:{type:"agent_message",text:"done " + "x".repeat(10_000)}});
  emit({type:"turn.completed"});
}
`,
    { mode: 0o700 },
  );
  return { root, temporary, dataDir, codex, cleanup };
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;

export function cli(f: Fixture, ...args: string[]) {
  return exec(process.execPath, ["src/client/orchestration.ts", ...args, "--data-dir", f.dataDir], {
    timeout: 10_000,
  });
}

export function submit(f: Fixture, goal: string) {
  return cli(f, "submit", "--workspace", f.root, "--goal", goal, "--completion", "Report done.");
}

export async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 6000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for state.");
    await setTimeout(20);
  }
}

export async function spawnHost(f: Fixture) {
  const child = spawn(
    process.execPath,
    [
      "src/client/host.ts",
      "--workspace",
      f.root,
      "--data-dir",
      f.dataDir,
      "--port",
      "0",
      "--codex",
      f.codex,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, RUDY_FIXTURE_TOKEN: "fixture-only" },
    },
  );
  let diagnostics = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    diagnostics += chunk;
  });
  child.stdout.resume();
  const done = new Promise((resolve) => child.once("exit", resolve));
  f.cleanup.push(async () => {
    child.kill();
    await done;
  });
  const load = () => readConnection(f.dataDir);
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`Host exited: ${diagnostics}`);
    try {
      await request(load(), "/tasks");
      return true;
    } catch {
      return false;
    }
  });
  return {
    connection: load(),
    async crash() {
      child.kill("SIGKILL");
      await done;
    },
  };
}

export async function ready(connection: Connection, taskId: string): Promise<boolean> {
  const events = await request(connection, `/tasks/${taskId}/events`);
  return Array.isArray(events) && events.some((event) => event.message === "ready");
}
