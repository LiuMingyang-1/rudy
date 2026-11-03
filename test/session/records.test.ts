import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { CompactionResult } from "../../src/compaction/compact.ts";
import { type CompactionRecord, toRecord, validCheckpoint } from "../../src/session/records.ts";

const usage: Usage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const user = (content: string): AgentMessage => ({ role: "user", content, timestamp: 1 });
const messages: AgentMessage[] = [
  { role: "system", content: "prompt", timestamp: 1 },
  user("first"),
  user("second"),
];
const record: CompactionRecord = {
  type: "compaction",
  summary: "summary",
  usage,
  timestamp: 1,
  firstKept: 2,
  messageCount: 3,
  tokensBefore: 100,
  tokensAfter: 20,
};

test("checkpoints reject low ordinals, tool-result boundaries and regressions", () => {
  assert.equal(validCheckpoint(record, messages), true);
  for (const firstKept of [0, 1]) {
    assert.equal(validCheckpoint({ ...record, firstKept }, messages), false);
  }
  const boundary: AgentMessage[] = [
    { role: "system", content: "prompt", timestamp: 1 },
    {
      role: "toolResult",
      toolCallId: "call",
      toolName: "read_file",
      content: [{ type: "text", text: "done" }],
      isError: false,
      timestamp: 1,
    },
    user("second"),
  ];
  assert.equal(validCheckpoint({ ...record, firstKept: 2 }, boundary), false);
  assert.equal(
    validCheckpoint({ ...record, firstKept: 2 }, messages, { ...record, firstKept: 3 }),
    false,
  );
});

test("toRecord rejects invalid checkpoints without producing a record", () => {
  const result: CompactionResult = {
    summary: "summary",
    usage,
    timestamp: 1,
    firstKept: 2,
    tokensBefore: 100,
    tokensAfter: 20,
    replacement: [],
  };
  assert.deepEqual(toRecord(result, messages), record);
  assert.throws(
    () => toRecord({ ...result, firstKept: 1 }, messages),
    /Compaction produced an invalid checkpoint/,
  );
  assert.throws(
    () => toRecord({ ...result, firstKept: 2 }, messages, { ...record, firstKept: 3 }),
    /Compaction produced an invalid checkpoint/,
  );
});
