import assert from "node:assert/strict";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createRudy } from "../../src/agent.ts";
import { compactionDefaults } from "../../src/config.ts";
import { openSession } from "../../src/session/session.ts";
import { fixture, user } from "./fixture.ts";

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
    ...compactionDefaults,
  });
  await openSession(otherAgent, {
    workspace: otherWorkspace,
    compaction: { ...compactionDefaults, maxTokens: 4096 },
    storageRoot: f.storage,
  });
  const otherTool = otherAgent.state.tools.find(
    (candidate) => candidate.name === "read_session_history",
  );
  assert.ok(otherTool);
  await assert.rejects(otherTool.execute("history", { cursor: oldCursor }), /cursor/);
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
