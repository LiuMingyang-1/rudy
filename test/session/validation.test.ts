import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fixture } from "./fixture.ts";

test("corrupt records, invalid message shapes and unsupported versions fail explicitly", async (t) => {
  const f = await fixture(t);
  const agent = await f.agent();
  await f.open(agent);
  const file = join(f.directory, `${agent.sessionId}.jsonl`);
  const original = await readFile(file, "utf8");
  for (const contents of [
    `${original}{bad json}\n`,
    `${original}${JSON.stringify({ type: "message", message: { role: "user", content: 42, timestamp: 1 } })}\n`,
    original.replace('"version":1', '"version":2'),
    original.replace(f.workspace, "/different-workspace"),
    original.replace('"toolsAdded":[', '"sections":42,"toolsAdded":['),
    original.replace('"toolsAdded":[', '"toolsRemoved":[null],"toolsAdded":['),
  ]) {
    await writeFile(file, contents);
    await assert.rejects(f.open(await f.agent()), /session|message/i);
    assert.equal(await readFile(file, "utf8"), contents);
  }
});

test("bad or dangling current pointers never silently create a new session", async (t) => {
  const f = await fixture(t);
  const agent = await f.agent();
  await f.open(agent);
  for (const pointer of [
    "{",
    '{"id":"../../outside"}',
    '{"id":"00000000-0000-4000-8000-000000000000"}',
  ]) {
    await writeFile(join(f.directory, "current.json"), pointer);
    await assert.rejects(f.open(await f.agent()));
    assert.equal(await readFile(join(f.directory, "current.json"), "utf8"), pointer);
  }
});
