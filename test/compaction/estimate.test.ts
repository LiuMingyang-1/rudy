import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { estimateMessage, estimateText, recentStart } from "../../src/compaction/tokens.ts";
import { user } from "./fixture.ts";

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
