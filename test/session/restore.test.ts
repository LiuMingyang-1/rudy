import assert from "node:assert/strict";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { fixture } from "./fixture.ts";

test("tool calls and results survive restore; interrupted calls are closed without executing tools", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.workspace, "notes.txt"), "A note");
  const agent = await f.agent();
  const faux = createFauxCore({});
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read_file", { path: "notes.txt" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Done"),
  ]);
  agent.streamFunction = faux.streamSimple;
  const session = await f.open(agent);
  await session.prompt("Read notes");
  const file = join(f.directory, `${agent.sessionId}.jsonl`);
  const original = await readFile(file, "utf8");
  const next = await f.agent();
  await f.open(next);
  assert.equal(JSON.stringify(next.state.messages), JSON.stringify(agent.state.messages));
  const lines = original.trim().split("\n");
  const result = lines.findIndex((line) => line.includes('"role":"toolResult"'));
  assert.ok(result > 0);
  await writeFile(file, `${lines.slice(0, result).join("\n")}\n`);
  const interrupted = await f.agent();
  await f.open(interrupted);
  const last = interrupted.state.messages.at(-1);
  assert.equal(last?.role, "toolResult");
  assert.equal(last.isError, true);
  const repaired = await readFile(file, "utf8");
  await f.open(await f.agent());
  assert.equal(await readFile(file, "utf8"), repaired);
});

test("recovery truncates a partial UTF-8 tail before subsequent appends", async (t) => {
  const f = await fixture(t);
  const agent = await f.agent();
  await f.open(agent);
  const file = join(f.directory, `${agent.sessionId}.jsonl`);
  const original = await readFile(file);
  await appendFile(file, Buffer.from([123, 34, 0xe4, 0xbd]));
  const next = await f.agent();
  const session = await f.open(next);
  assert.deepEqual(await readFile(file), original);
  const faux = createFauxCore({});
  faux.setResponses([fauxAssistantMessage("Recovered")]);
  next.streamFunction = faux.streamSimple;
  await session.prompt("你好");
  await f.open(await f.agent());
});

test("restore completes only missing results in a trailing tool-call batch", async (t) => {
  const f = await fixture(t);
  const agent = await f.agent();
  await f.open(agent);
  const file = join(f.directory, `${agent.sessionId}.jsonl`);
  const calls = [
    fauxToolCall("read_file", { path: "a.txt" }),
    fauxToolCall("read_file", { path: "b.txt" }),
  ];
  const completed = {
    role: "toolResult",
    toolCallId: calls[1].id,
    toolName: calls[1].name,
    content: [{ type: "text", text: "Already completed" }],
    isError: false,
    timestamp: 1,
  };
  const messages = [
    fauxAssistantMessage(fauxToolCall("read_file", { path: "earlier.txt" }), {
      stopReason: "toolUse",
    }),
    { role: "user", content: "A later request", timestamp: 1 },
    fauxAssistantMessage(calls, { stopReason: "toolUse" }),
    completed,
  ];
  await appendFile(
    file,
    messages.map((message) => `${JSON.stringify({ type: "message", message })}\n`).join(""),
  );
  const before = await readFile(file, "utf8");
  await appendFile(file, '{"type":');
  const next = await f.agent();
  await f.open(next);
  const results = next.state.messages.filter((message) => message.role === "toolResult");
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], completed);
  assert.equal(results[1].toolCallId, calls[0].id);
  assert.equal(results[1].isError, true);
  assert.ok((await readFile(file, "utf8")).startsWith(before));
});

test("unfinished calls in the middle restore unchanged while partial tails are truncated", async (t) => {
  const f = await fixture(t);
  const agent = await f.agent();
  const session = await f.open(agent);
  const id = agent.sessionId;
  assert.ok(id);
  const file = join(f.directory, `${id}.jsonl`);
  const original = await readFile(file, "utf8");
  const baseline = structuredClone(agent.state.messages);
  const pointer = join(f.directory, "current.json");
  const call = fauxToolCall("read_file", { path: "notes.txt" });
  const invocation = fauxAssistantMessage(call, { stopReason: "toolUse" });
  const lateResult = {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: "Too late" }],
    isError: false,
    timestamp: 1,
  };
  for (const later of [
    [
      { role: "user", content: "Later question", timestamp: 1 },
      fauxAssistantMessage("Later answer"),
    ],
    [fauxAssistantMessage("Later answer")],
    [{ role: "system", content: "Later instructions", timestamp: 1 }],
    [{ role: "user", content: "Later question", timestamp: 1 }, lateResult],
  ]) {
    await session.reset();
    const recorded = [{ role: "user", content: "Read notes", timestamp: 1 }, invocation, ...later];
    const contents =
      original +
      recorded.map((message) => `${JSON.stringify({ type: "message", message })}\n`).join("");
    await writeFile(file, `${contents}{"type":`);
    // Listing validates storage format only, without repairing or pairing calls.
    assert.ok((await session.list()).sessions.some((summary) => summary.id === id));
    assert.equal(await readFile(file, "utf8"), `${contents}{"type":`);
    await session.resume(id);
    assert.equal(await readFile(file, "utf8"), contents);
    assert.equal(await readFile(pointer, "utf8"), `${JSON.stringify({ id })}\n`);
    assert.equal(agent.sessionId, id);
    assert.equal(JSON.stringify(agent.state.messages), JSON.stringify([...baseline, ...recorded]));
    const next = await f.agent();
    await f.open(next);
    assert.equal(await readFile(file, "utf8"), contents);
    assert.deepEqual(next.state.messages, agent.state.messages);
  }
});
