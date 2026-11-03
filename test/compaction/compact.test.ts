import assert from "node:assert/strict";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { estimateMessage, estimateMessages } from "../../src/compaction/tokens.ts";
import { fixture, noUsage, user } from "./fixture.ts";

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
