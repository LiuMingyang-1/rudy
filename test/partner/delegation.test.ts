import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { loadConfig } from "../../src/config.ts";
import { startHost } from "../../src/host/local.ts";
import { nowledge } from "../../src/partner/memory.ts";
import type { Task } from "../../src/protocol/task.ts";
import { day3 } from "../orchestration/day3-fixture.ts";
import { cli } from "../orchestration/fixture.ts";

const fix = {
  goal: "Fix the regression",
  scope: "file.txt",
  completion: "Report verification results",
  constraints: "Keep the change focused",
  harness: "codex",
  review: false,
};
const answer = (...tasks: object[]) => fauxAssistantMessage(JSON.stringify({ tasks }));

async function setup(t: TestContext, lowThreshold = false) {
  const d = await day3(t);
  const faux = createFauxCore({});
  const open = async (memory?: ReturnType<typeof nowledge>) => {
    const host = await startHost({
      dataDir: d.f.dataDir,
      workspaceRoot: d.f.root,
      port: 0,
      codex: d.f.codex,
      claude: join(d.f.temporary, "fake-review"),
      partner: {
        config: () =>
          loadConfig({
            RUDY_PROVIDER: "fixture",
            RUDY_BASE_URL: "http://127.0.0.1",
            RUDY_MODEL: "fixture-model",
            RUDY_API_KEY: "unused",
            RUDY_CONTEXT_WINDOW: "8000",
            RUDY_MAX_TOKENS: "512",
            RUDY_COMPACTION_THRESHOLD: lowThreshold ? "0.2" : "0.8",
            RUDY_COMPACTION_KEEP_RECENT_TOKENS: "150",
          }),
        stream: faux.streamSimple,
        memory,
      },
    });
    d.f.cleanup.push(host.close);
    return host;
  };
  const delegate = async (text: string, ...args: string[]) => {
    const { stdout } = await cli(
      d.f,
      "delegate",
      text,
      "--workspace",
      d.f.root,
      "--base",
      "main",
      ...args,
    );
    return JSON.parse(stdout) as { tasks: Task[]; memoryStatus?: string };
  };
  const conversation = async () => {
    const storage = join(d.f.dataDir, "partner");
    const [file] = (await readdir(storage, { recursive: true })).filter((name) =>
      name.endsWith(".jsonl"),
    );
    return readFile(join(storage, file), "utf8");
  };
  return { ...d, open, delegate, conversation, faux };
}

test("Partner delegates a fix and review and resumes with the Host's current task status", async (t) => {
  const d = await setup(t);
  const host = await d.open();
  d.faux.setResponses([
    (context) => {
      assert.match(JSON.stringify(context.messages), /Fix and review/);
      assert.doesNotMatch(JSON.stringify(context.messages), /read_file|list_dir|write_file/);
      return answer(
        { ...fix, workspace: d.f.dataDir, device: "unauthorized" },
        { ...fix, goal: "Review the regression fix", harness: "claude-code", review: true },
      );
    },
    (context) => {
      const messages = JSON.stringify(context.messages);
      assert.match(messages, /Fix and review/);
      assert.match(messages, /Check another edge case/);
      assert.match(messages, /succeeded/);
      return answer(fix);
    },
  ]);
  const {
    tasks: [writer, reviewer],
  } = await d.delegate("Fix and review");
  assert.equal(writer.brief.workspace, d.f.root);
  assert.equal(writer.harness, "codex");
  assert.equal(reviewer.after, writer.taskId);
  assert.equal(reviewer.status, "waiting");
  assert.equal(reviewer.review, true);
  assert.equal(reviewer.harness, "claude-code");
  await d.state(reviewer.taskId, "succeeded");
  await host.close();
  await d.open();
  const next = await d.delegate("Check another edge case");
  await d.state(next.tasks[0].taskId, "succeeded");
});

test("explicit Nowledge decisions can be recalled, and an unavailable service leaves delegation working", async (t) => {
  const d = await setup(t);
  const command = join(d.f.temporary, "mock-nmem");
  const saved = join(d.f.temporary, "decision");
  await writeFile(
    command,
    `#!/bin/sh
case "$2" in
  add) /bin/cat > "${saved}" ;;
  search)
    case "${"$"}{8}" in
      offline) exit 1 ;;
      *) /bin/cat "${saved}" ;;
    esac ;;
esac
`,
    { mode: 0o700 },
  );
  await d.open(nowledge(command));
  const decision = "Use a narrow regression test";
  assert.match((await cli(d.f, "remember", decision)).stdout, /Decision saved/);
  assert.equal(await readFile(saved, "utf8"), decision);
  d.faux.setResponses([
    (context) => {
      assert.match(JSON.stringify(context.messages), /Use a narrow regression test/);
      return answer(fix);
    },
    (context) => {
      assert.match(JSON.stringify(context.messages), /Continue using local context/);
      return answer(fix);
    },
  ]);
  const recall = await d.delegate("Use my saved decision", "--recall", "verification");
  await d.state(recall.tasks[0].taskId, "succeeded");
  const offline = await d.delegate("Continue using local context", "--recall", "offline");
  assert.match(offline.memoryStatus ?? "", /Nowledge Mem unavailable/);
  await d.state(offline.tasks[0].taskId, "succeeded");
});

test("failed Partner compaction preserves history and a later successful summary keeps the new request", async (t) => {
  const d = await setup(t, true);
  await d.open();
  d.faux.setResponses([
    answer(fix),
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 summary refused" }),
    (context) => {
      const messages = JSON.stringify(context.messages);
      assert.match(messages, /Original request/);
      assert.match(messages, /Second request/);
      return fauxAssistantMessage("Saved rolling summary");
    },
    (context) => {
      const messages = JSON.stringify(context.messages);
      assert.match(messages, /Saved rolling summary/);
      assert.match(messages, /Retry with a short request/);
      assert.doesNotMatch(messages, /Original request/);
      return answer(fix);
    },
  ]);
  const first = await d.delegate(`Original request ${"x".repeat(4500)}`);
  await d.state(first.tasks[0].taskId, "succeeded");
  const before = await d.conversation();
  await assert.rejects(d.delegate(`Second request ${"y".repeat(4500)}`), /summary refused/);
  assert.equal(d.faux.state.callCount, 2);
  const failed = await d.conversation();
  assert.ok(failed.startsWith(before));
  assert.doesNotMatch(failed, /"type":"compaction"/);
  assert.equal(JSON.parse((await cli(d.f, "list")).stdout).length, 1);
  const retried = await d.delegate("Retry with a short request");
  await d.state(retried.tasks[0].taskId, "succeeded");
  const saved = await d.conversation();
  assert.ok(saved.startsWith(failed));
  assert.match(saved, /"type":"compaction"/);
});
