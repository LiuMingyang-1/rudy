import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  type Usage,
} from "@earendil-works/pi-ai";
import { createRudy } from "../src/agent.ts";
import {
  type CompactionOptions,
  estimateMessage,
  estimateMessages,
  estimateText,
  generateSummary,
  recentStart,
} from "../src/session/compaction.ts";
import { openSession } from "../src/session/session.ts";

async function fixture(
  t: { after(fn: () => Promise<void>): void },
  options: CompactionOptions = {},
) {
  const temporary = await mkdtemp(join(tmpdir(), "rudy-compaction-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const workspace = join(temporary, "workspace");
  const storage = join(temporary, "storage");
  await mkdir(workspace);
  const directory = join(
    storage,
    createHash("sha256")
      .update(await realpath(workspace))
      .digest("hex"),
  );
  async function create() {
    const agent = await createRudy({
      provider: "openai",
      model: "gpt-5.4",
      apiKey: "unused",
      workspace,
      contextWindow: 128000,
      maxTokens: 4096,
    });
    const faux = createFauxCore({});
    agent.streamFunction = faux.streamSimple;
    const session = await openSession(agent, workspace, storage, {
      compactionKeepRecentTokens: 100,
      ...options,
    });
    return { agent, faux, session, file: join(directory, `${agent.sessionId}.jsonl`) };
  }
  return { workspace, storage, directory, create };
}

const user = (content: string): AgentMessage => ({ role: "user", content, timestamp: 1 });
const noUsage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

test("local tokens count Unicode code points, system/tools and tool arguments", () => {
  assert.equal(estimateText("abcd"), 1);
  assert.equal(estimateText("中文"), 3);
  assert.equal(estimateText("😀"), 2);
  assert.equal(estimateText("abcd中文😀"), 6);
  const message = fauxAssistantMessage(fauxToolCall("read_file", { path: "x".repeat(400) }));
  assert.ok(estimateMessage(message) > 100);
  assert.ok(
    estimateMessage({
      role: "system",
      content: "",
      sections: { rules: "中".repeat(100) },
      timestamp: 0,
    }) > 150,
  );
});

test("recent suffix excludes the exact 120% boundary and keeps complete tool batches", () => {
  const small = user("a".repeat(100));
  const large = user("a".repeat(500));
  const target = estimateMessage(large) / 1.2;
  assert.equal(recentStart([small, large], target), 2);
  assert.equal(recentStart([small, large], target + 1), 1);
  const calls = [
    fauxToolCall("read_file", { path: "a" }),
    fauxToolCall("read_file", { path: "b" }),
  ];
  const batch: AgentMessage[] = [
    fauxAssistantMessage(calls, { stopReason: "toolUse" }),
    ...calls.map((call) => ({
      role: "toolResult" as const,
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text" as const, text: "z".repeat(600) }],
      isError: false,
      timestamp: 1,
    })),
  ];
  const messages = [small, ...batch, small];
  const start = recentStart(messages, 150);
  assert.equal(start, messages.length - 1);
  assert.equal(recentStart(batch, 100), batch.length);
  assert.equal(recentStart(batch, 1000), 0);
});

test("manual checkpoints preserve raw ordinals, restore latest summary and do not duplicate message events", async (t) => {
  const f = await fixture(t);
  const first = await f.create();
  first.faux.setResponses([
    fauxAssistantMessage("Answer"),
    (context) => {
      assert.match(JSON.stringify(context.messages), /Old question/);
      assert.match(JSON.stringify(context.messages), /Answer/);
      return fauxAssistantMessage("Summary one");
    },
  ]);
  await first.session.prompt(`Old question ${"x".repeat(8000)}`);
  const original = await readFile(first.file, "utf8");
  const timestamp = (await first.session.list())[0].timestamp;
  assert.equal(await first.session.compact(), true);
  assert.equal((await first.session.list())[0].timestamp, timestamp);
  const saved = await readFile(first.file, "utf8");
  assert.ok(saved.startsWith(original));
  assert.equal(saved.split('"type":"compaction"').length - 1, 1);
  assert.equal(saved.split('"type":"message"').length - 1, 3);
  const checkpoint = JSON.parse(saved.trim().split("\n").at(-1) ?? "");
  assert.equal(checkpoint.firstKept, 3);
  assert.equal(checkpoint.messageCount, 3);
  const restored = await f.create();
  assert.deepEqual(restored.agent.state.messages, first.agent.state.messages);
  restored.faux.setResponses([
    fauxAssistantMessage("Another answer"),
    (context) => {
      const text = JSON.stringify(context.messages);
      assert.match(text, /Summary one/);
      assert.match(text, /New question/);
      assert.doesNotMatch(text, /Old question/);
      return fauxAssistantMessage("Summary two");
    },
  ]);
  await restored.session.prompt(`New question ${"y".repeat(8000)}`);
  assert.equal(await restored.session.compact(), true);
  assert.equal(await restored.session.compact(), false);
  const latest = await f.create();
  assert.deepEqual(latest.agent.state.messages, restored.agent.state.messages);
  assert.match(JSON.stringify(latest.agent.state.messages), /Summary two/);
  assert.doesNotMatch(JSON.stringify(latest.agent.state.messages), /Summary one|New question/);
  await latest.session.reset();
  assert.equal(await latest.session.compact(), false);
  assert.doesNotMatch(JSON.stringify(latest.agent.state.messages), /Summary two/);
});

test("automatic first request compacts at 80%, accepts an empty tail and updates the next run", async (t) => {
  const f = await fixture(t, { compactionKeepRecentTokens: 1, maxTokens: 100 });
  const { agent, faux, session, file } = await f.create();
  agent.state.model = { ...agent.state.model, contextWindow: 20000 };
  let effective: AgentMessage[] = [];
  faux.setResponses([
    (context) => {
      assert.match(JSON.stringify(context.messages), /Current task/);
      return fauxAssistantMessage("Perform the current task.");
    },
    (context) => {
      assert.equal(context.messages.length, 2);
      assert.equal(context.messages.at(-1)?.role, "user");
      effective = [...context.messages];
      return fauxAssistantMessage("Done");
    },
    (context) => {
      assert.deepEqual(context.messages.slice(0, 2), effective);
      return fauxAssistantMessage("Followup done");
    },
  ]);
  const initial = estimateMessages(agent.state.messages);
  const prefix = "Current task ";
  const request = prefix + "x".repeat((16000 - initial - estimateMessage(user(prefix))) * 4);
  assert.ok(estimateMessages([...agent.state.messages, user(request)]) >= 16000);
  await session.prompt(request);
  assert.equal(faux.state.callCount, 2);
  const record = JSON.parse(
    (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .find((line) => line.includes('"type":"compaction"')) ?? "",
  );
  assert.equal(record.firstKept, record.messageCount + 1);
  await session.prompt("Continue");
  assert.equal(faux.state.callCount, 3);
  assert.deepEqual((await f.create()).agent.state.messages, agent.state.messages);
});

test("valid API usage adds only subsequent messages; model changes invalidate the baseline", async (t) => {
  const f = await fixture(t, { compactionKeepRecentTokens: 1, maxTokens: 100 });
  const { agent, faux, session, file } = await f.create();
  agent.state.model = { ...agent.state.model, contextWindow: 20000 };
  const answer = fauxAssistantMessage("a".repeat(1200));
  answer.usage = {
    ...noUsage,
    input: 8000,
    cacheRead: 7000,
    cacheWrite: 400,
    output: 500,
    totalTokens: 999999,
  };
  agent.subscribe((event) => {
    if (
      event.type === "message_end" &&
      event.message.role === "assistant" &&
      event.message.content.some((part) => part.type === "text" && part.text === "a".repeat(1200))
    )
      event.message.usage = answer.usage;
  });
  faux.setResponses([answer, fauxAssistantMessage("Usage summary"), fauxAssistantMessage("Done")]);
  await session.prompt("First");
  await session.prompt("Next".repeat(200));
  assert.equal(faux.state.callCount, 3);
  const record = JSON.parse(
    (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .find((line) => line.includes('"type":"compaction"')) ?? "",
  );
  assert.equal(
    record.tokensBefore,
    15900 +
      estimateMessage({
        role: "user",
        content: [{ type: "text", text: "Next".repeat(200) }],
        timestamp: 1,
      }),
  );
  // Summary usage never becomes the conversation baseline, and old usage in the
  // retained tail is invalidated by replacing the context.
  faux.setResponses([fauxAssistantMessage("Next answer")]);
  await session.prompt("Small followup");
  assert.equal(faux.state.callCount, 4);
  await session.reset();
  faux.setResponses([answer, fauxAssistantMessage("No summary needed")]);
  await session.prompt("First");
  agent.state.model = { ...agent.state.model, id: "changed-model" };
  await session.prompt("Next".repeat(200));
  assert.equal(faux.state.callCount, 6);
});

test("tool continuation is checked and an oversized latest batch can be summarized whole", async (t) => {
  const f = await fixture(t, { compactionKeepRecentTokens: 1, maxTokens: 100 });
  await writeFile(join(f.workspace, "large.txt"), "x".repeat(60000));
  const { agent, faux, session } = await f.create();
  agent.state.model = { ...agent.state.model, contextWindow: 19000 };
  const invocation = fauxAssistantMessage(fauxToolCall("read_file", { path: "large.txt" }), {
    stopReason: "toolUse",
  });
  invocation.usage = noUsage;
  faux.setResponses([
    invocation,
    (context) => {
      assert.match(JSON.stringify(context.messages), /toolResult/);
      return fauxAssistantMessage("The file was read. Answer the user.");
    },
    (context) => {
      assert.equal(context.messages.length, 2);
      assert.ok(context.messages.every((message) => message.role !== "toolResult"));
      return fauxAssistantMessage("Done");
    },
  ]);
  await session.prompt("Read large.txt");
  assert.equal(faux.state.callCount, 3);
  assert.equal(agent.state.errorMessage, undefined);
});

test("summary retries share three attempts, quality retries once, and provider retries are disabled", async (t) => {
  const f = await fixture(t);
  const { agent, faux } = await f.create();
  const budgets: number[] = [];
  agent.streamFunction = (model, context, options) => {
    assert.equal(options?.maxRetries, 0);
    budgets.push(options?.maxTokens ?? 0);
    return faux.streamSimple(model, context, options);
  };
  faux.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 temporarily unavailable" }),
    fauxAssistantMessage("Cut", { stopReason: "length" }),
    fauxAssistantMessage("Complete"),
  ]);
  assert.equal(
    (await generateSummary(agent, agent.state.model, [user("history")], 100)).summary,
    "Complete",
  );
  assert.deepEqual(budgets, [100, 100, 200]);
  const before = faux.state.callCount;
  faux.setResponses([fauxAssistantMessage(""), fauxAssistantMessage("")]);
  await assert.rejects(generateSummary(agent, agent.state.model, [user("history")], 100), /empty/);
  assert.equal(faux.state.callCount - before, 2);
  for (const response of [
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 unauthorized" }),
    fauxAssistantMessage(fauxToolCall("read_file", { path: "a" }), { stopReason: "toolUse" }),
  ]) {
    const count = faux.state.callCount;
    faux.setResponses([response]);
    await assert.rejects(generateSummary(agent, agent.state.model, [user("history")], 100));
    assert.equal(faux.state.callCount, count + 1);
  }
  const count = faux.state.callCount;
  faux.setResponses(
    Array.from({ length: 3 }, () =>
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "503 temporarily unavailable",
      }),
    ),
  );
  await assert.rejects(generateSummary(agent, agent.state.model, [user("history")], 100), /503/);
  assert.equal(faux.state.callCount, count + 3);
});

test("manual cancellation retains the mutex until summary settles and commits no checkpoint", async (t) => {
  const f = await fixture(t);
  const { agent, faux, session, file } = await f.create();
  faux.setResponses([fauxAssistantMessage("Done")]);
  await session.prompt("x".repeat(8000));
  const before = await readFile(file, "utf8");
  const history = [...agent.state.messages];
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  agent.streamFunction = async (model, context, options) => {
    entered?.();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return faux.streamSimple(model, context, options);
  };
  const compacting = session.compact();
  await started;
  assert.equal(session.busy, true);
  session.cancel();
  await assert.rejects(session.reset(), /busy/);
  await assert.rejects(session.compact(), /busy/);
  await assert.rejects(session.resume(agent.sessionId ?? ""), /busy/);
  await assert.rejects(session.prompt("Overlap"), /busy/);
  release?.();
  await assert.rejects(compacting, /abort/i);
  assert.equal(session.busy, false);
  assert.deepEqual(agent.state.messages, history);
  assert.equal(await readFile(file, "utf8"), before);
});

test("canceling automatic compaction during retry prevents the conversational request", async (t) => {
  const f = await fixture(t, { compactionKeepRecentTokens: 1, maxTokens: 100 });
  const { agent, faux, session, file } = await f.create();
  agent.state.model = { ...agent.state.model, contextWindow: 20000 };
  let scheduled: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    scheduled = resolve;
  });
  faux.setResponses([
    () => {
      scheduled?.();
      return fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "503 temporarily unavailable",
      });
    },
  ]);
  const operation = session.prompt("x".repeat(64000));
  await started;
  session.cancel();
  await assert.rejects(operation, /abort/i);
  assert.equal(faux.state.callCount, 1);
  assert.doesNotMatch(await readFile(file, "utf8"), /"type":"compaction"/);
});

test("failed checkpoint writes preserve memory and block further work without regenerating", async (t) => {
  const f = await fixture(t);
  const { agent, faux, session, file } = await f.create();
  faux.setResponses([fauxAssistantMessage("Done"), fauxAssistantMessage("Summary")]);
  await session.prompt("x".repeat(8000));
  const history = [...agent.state.messages];
  await rename(file, `${file}.backup`);
  await mkdir(file);
  await assert.rejects(session.compact(), /Session write failed/);
  assert.deepEqual(agent.state.messages, history);
  assert.equal(faux.state.callCount, 2);
  await assert.rejects(session.compact(), /Session write failed/);
  assert.equal(faux.state.callCount, 2);
  await session.reset();
  assert.equal(await session.compact(), false);
});

test("history pagination bounds output, continues long messages and rejects foreign cursors", async (t) => {
  const f = await fixture(t, { compactionKeepRecentTokens: 1 });
  const { agent, faux, session } = await f.create();
  faux.setResponses([fauxAssistantMessage("Done"), fauxAssistantMessage("Summary")]);
  const original = '"\\\n中'.repeat(8000);
  await session.prompt(original);
  await session.compact();
  const tool = agent.state.tools.find((tool) => tool.name === "read_session_history");
  assert.ok(tool);
  let cursor: string | undefined;
  let recovered = "";
  let pages = 0;
  do {
    const result: AgentToolResult = await tool.execute("history", { cursor });
    const text = result.content[0];
    assert.equal(text.type, "text");
    assert.ok(text.text.length <= 16000);
    const page: {
      entries: { number: number; role: string; fragment: string; offset: number }[];
      nextCursor?: string;
    } = JSON.parse(text.text);
    assert.ok(page.entries.length <= 50);
    for (const entry of page.entries) if (entry.number === 2) recovered += entry.fragment;
    cursor = page.nextCursor;
    pages++;
    assert.ok(pages < 100);
  } while (cursor);
  assert.ok(pages > 2);
  assert.deepEqual(JSON.parse(recovered).content, [{ type: "text", text: original }]);
  for (const cursor of [
    "",
    "../outside",
    `2:999999999999:${agent.sessionId}`,
    `0:0:${agent.sessionId}`,
    "2:0:00000000-0000-4000-8000-000000000000",
  ])
    await assert.rejects(tool.execute("history", { cursor }), /cursor/);
  const oldCursor = `2:0:${agent.sessionId}`;
  await session.reset();
  await assert.rejects(tool.execute("history", { cursor: oldCursor }), /cursor/);
  const empty = await tool.execute("history", {});
  assert.doesNotMatch(JSON.stringify(empty), /中/);
  const otherWorkspace = join(f.workspace, "other");
  await mkdir(otherWorkspace);
  const otherAgent = await createRudy({
    provider: "openai",
    model: "gpt-5.4",
    apiKey: "unused",
    workspace: otherWorkspace,
    contextWindow: 128000,
    maxTokens: 4096,
  });
  await openSession(otherAgent, otherWorkspace, f.storage);
  const otherTool = otherAgent.state.tools.find(
    (candidate) => candidate.name === "read_session_history",
  );
  assert.ok(otherTool);
  await assert.rejects(otherTool.execute("history", { cursor: oldCursor }), /cursor/);
});

test("compaction records validate boundaries and partial checkpoint tails are repaired", async (t) => {
  const f = await fixture(t);
  const { faux, session, file } = await f.create();
  faux.setResponses([fauxAssistantMessage("Done"), fauxAssistantMessage("Summary")]);
  await session.prompt("x".repeat(8000));
  await session.compact();
  const saved = await readFile(file, "utf8");
  await appendFile(file, '{"type":"compaction"');
  await f.create();
  assert.equal(await readFile(file, "utf8"), saved);
  const lines = saved.trim().split("\n");
  const record = JSON.parse(lines.at(-1) ?? "");
  for (const change of [
    { firstKept: 999 },
    { messageCount: 0 },
    { summary: "" },
    { type: "unexpected" },
  ]) {
    await writeFile(
      file,
      `${lines.slice(0, -1).join("\n")}\n${JSON.stringify({ ...record, ...change })}\n`,
    );
    await assert.rejects(f.create(), /session|compaction/i);
  }
});

test("zero, failed and restored usage fall back to local estimates", async (t) => {
  const f = await fixture(t, { compactionKeepRecentTokens: 1, maxTokens: 100 });
  const { agent, faux, session } = await f.create();
  agent.state.model = { ...agent.state.model, contextWindow: 20000 };
  agent.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      event.message.usage =
        event.message.stopReason === "error" ? { ...noUsage, input: 19999 } : noUsage;
    }
  });
  faux.setResponses([
    fauxAssistantMessage("a".repeat(3000)),
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 unauthorized" }),
    fauxAssistantMessage("Local estimate"),
  ]);
  await session.prompt("First");
  await assert.rejects(session.prompt("Failed"), /401/);
  await session.prompt("Continue");
  assert.equal(faux.state.callCount, 3);
  const restored = await f.create();
  restored.agent.state.model = { ...restored.agent.state.model, contextWindow: 20000 };
  restored.faux.setResponses([fauxAssistantMessage("Restored")]);
  await restored.session.prompt("Continue after restart");
  assert.equal(restored.faux.state.callCount, 1);
});

test("unusable summaries and budgets leave the original context and file unchanged", async (t) => {
  const f = await fixture(t);
  const { agent, faux, session, file } = await f.create();
  faux.setResponses([fauxAssistantMessage("Done"), fauxAssistantMessage("x".repeat(20000))]);
  await session.prompt("x".repeat(8000));
  const before = await readFile(file, "utf8");
  const messages = [...agent.state.messages];
  await assert.rejects(session.compact(), /did not reduce/);
  assert.deepEqual(agent.state.messages, messages);
  assert.equal(await readFile(file, "utf8"), before);
  const count = faux.state.callCount;
  await assert.rejects(
    generateSummary(agent, { ...agent.state.model, contextWindow: 1000 }, messages, 8192),
    /input does not fit/,
  );
  assert.equal(faux.state.callCount, count);
  agent.streamFunction = (model, context, options) => {
    assert.equal(options?.maxTokens, 500);
    return faux.streamSimple(model, context, options);
  };
  faux.setResponses([
    fauxAssistantMessage("Cut", { stopReason: "length" }),
    fauxAssistantMessage("Complete"),
  ]);
  await generateSummary(agent, { ...agent.state.model, maxTokens: 500 }, [user("history")], 100000);
});

test("history returns at most 50 messages and keeps tool association on fragments", async (t) => {
  const f = await fixture(t);
  const { file } = await f.create();
  const call = fauxToolCall("read_file", { path: "a" });
  const messages: AgentMessage[] = [
    ...Array.from({ length: 60 }, (_, index) => user(`Message ${index}`)),
    fauxAssistantMessage(call, { stopReason: "toolUse" }),
    {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: "Done" }],
      isError: false,
      timestamp: 1,
    },
  ];
  await appendFile(
    file,
    messages.map((message) => `${JSON.stringify({ type: "message", message })}\n`).join(""),
  );
  const { agent } = await f.create();
  const tool = agent.state.tools.find((candidate) => candidate.name === "read_session_history");
  assert.ok(tool);
  const result = await tool.execute("history", {});
  const text = result.content[0];
  assert.equal(text.type, "text");
  const page = JSON.parse(text.text);
  assert.equal(page.entries.length, 50);
  assert.equal(page.entries[0].role, "toolResult");
  assert.deepEqual(page.entries[0].toolCallIds, [call.id]);
  assert.deepEqual(page.entries[1].toolCallIds, [call.id]);
  assert.ok(page.nextCursor);
  const next = await tool.execute("history", { cursor: page.nextCursor });
  const content = next.content[0];
  assert.equal(content.type, "text");
  assert.equal(JSON.parse(content.text).entries.length, 13);
});
