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
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createRudy } from "../src/agent.ts";
import { openSession } from "../src/session/session.ts";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const temporary = await mkdtemp(join(tmpdir(), "rudy-session-"));
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
  async function agent() {
    return createRudy({
      provider: "openai",
      model: "gpt-5.4",
      apiKey: "not-to-be-stored",
      contextWindow: 128000,
      maxTokens: 4096,
      workspace,
    });
  }
  return { temporary, workspace, storage, directory, agent };
}

test("sessions restore full pi history and send it to the next model request", async (t) => {
  const f = await fixture(t);
  const agent = await f.agent();
  const faux = createFauxCore({});
  faux.setResponses([fauxAssistantMessage("First answer")]);
  agent.streamFunction = faux.streamSimple;
  const session = await openSession(agent, f.workspace, f.storage);
  await session.prompt("First question");
  const history = structuredClone(agent.state.messages);
  const id = agent.sessionId;
  const next = await f.agent();
  const restored = await openSession(next, f.workspace, f.storage);
  assert.equal(next.sessionId, id);
  assert.deepEqual(next.state.messages, history);
  const followup = createFauxCore({});
  followup.setResponses([
    (context) => {
      assert.deepEqual(context.messages.slice(0, history.length), history);
      return fauxAssistantMessage("Second answer");
    },
  ]);
  next.streamFunction = followup.streamSimple;
  await restored.prompt("Second question");
  assert.equal(next.state.errorMessage, undefined);
  const contents = await readFile(join(f.directory, `${id}.jsonl`), "utf8");
  assert.ok(!contents.includes("not-to-be-stored"));
  assert.equal(contents.trim().split("\n").length, next.state.messages.length + 1);
});

test("reset retains old files; resume updates the startup pointer; empty sessions are omitted", async (t) => {
  const f = await fixture(t);
  const agent = await f.agent();
  const faux = createFauxCore({});
  faux.setResponses([fauxAssistantMessage("Old answer"), fauxAssistantMessage("New answer")]);
  agent.streamFunction = faux.streamSimple;
  const session = await openSession(agent, f.workspace, f.storage);
  const baseline = structuredClone(agent.state.messages);
  assert.deepEqual(await session.list(), []);
  await session.prompt("Old question");
  const old = agent.sessionId;
  const oldHistory = structuredClone(agent.state.messages);
  await session.reset();
  assert.notEqual(agent.sessionId, old);
  assert.deepEqual(agent.state.messages, baseline);
  assert.equal((await session.list()).length, 1);
  await session.prompt("New question");
  const sessions = await session.list();
  assert.equal(sessions.length, 2);
  assert.ok(sessions[0].timestamp >= sessions[1].timestamp);
  assert.ok(old);
  await session.resume(old);
  assert.deepEqual(agent.state.messages, oldHistory);
  const next = await f.agent();
  await openSession(next, f.workspace, f.storage);
  assert.equal(next.sessionId, old);
  assert.deepEqual(next.state.messages, oldHistory);
});

test("workspace real paths isolate histories and aliases share the same session", async (t) => {
  const f = await fixture(t);
  const first = await f.agent();
  await openSession(first, f.workspace, f.storage);
  const alias = join(f.temporary, "alias");
  await symlink(f.workspace, alias);
  const same = await f.agent();
  await openSession(same, alias, f.storage);
  assert.equal(same.sessionId, first.sessionId);
  const other = join(f.temporary, "other");
  await mkdir(other);
  const different = await f.agent();
  await openSession(different, other, f.storage);
  assert.notEqual(different.sessionId, first.sessionId);
  await assert.rejects(
    (await openSession(different, other, f.storage)).resume(first.sessionId ?? ""),
    /ENOENT/,
  );
});

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
  const session = await openSession(agent, f.workspace, f.storage);
  await session.prompt("Read notes");
  const file = join(f.directory, `${agent.sessionId}.jsonl`);
  const original = await readFile(file, "utf8");
  const next = await f.agent();
  await openSession(next, f.workspace, f.storage);
  assert.equal(JSON.stringify(next.state.messages), JSON.stringify(agent.state.messages));
  const lines = original.trim().split("\n");
  const result = lines.findIndex((line) => line.includes('"role":"toolResult"'));
  assert.ok(result > 0);
  await writeFile(file, `${lines.slice(0, result).join("\n")}\n`);
  const interrupted = await f.agent();
  await openSession(interrupted, f.workspace, f.storage);
  const last = interrupted.state.messages.at(-1);
  assert.equal(last?.role, "toolResult");
  assert.equal(last.isError, true);
  const repaired = await readFile(file, "utf8");
  await openSession(await f.agent(), f.workspace, f.storage);
  assert.equal(await readFile(file, "utf8"), repaired);
});

test("recovery truncates a partial UTF-8 tail before subsequent appends", async (t) => {
  const f = await fixture(t);
  const agent = await f.agent();
  await openSession(agent, f.workspace, f.storage);
  const file = join(f.directory, `${agent.sessionId}.jsonl`);
  const original = await readFile(file);
  await appendFile(file, Buffer.from([123, 34, 0xe4, 0xbd]));
  const next = await f.agent();
  const session = await openSession(next, f.workspace, f.storage);
  assert.deepEqual(await readFile(file), original);
  const faux = createFauxCore({});
  faux.setResponses([fauxAssistantMessage("Recovered")]);
  next.streamFunction = faux.streamSimple;
  await session.prompt("你好");
  await openSession(await f.agent(), f.workspace, f.storage);
});

test("restore completes only missing results in a trailing tool-call batch", async (t) => {
  const f = await fixture(t);
  const agent = await f.agent();
  await openSession(agent, f.workspace, f.storage);
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
  await openSession(next, f.workspace, f.storage);
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
  const session = await openSession(agent, f.workspace, f.storage);
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
    assert.ok((await session.list()).some((summary) => summary.id === id));
    assert.equal(await readFile(file, "utf8"), `${contents}{"type":`);
    await session.resume(id);
    assert.equal(await readFile(file, "utf8"), contents);
    assert.equal(await readFile(pointer, "utf8"), `${JSON.stringify({ id })}\n`);
    assert.equal(agent.sessionId, id);
    assert.equal(JSON.stringify(agent.state.messages), JSON.stringify([...baseline, ...recorded]));
    const next = await f.agent();
    await openSession(next, f.workspace, f.storage);
    assert.equal(await readFile(file, "utf8"), contents);
    assert.deepEqual(next.state.messages, agent.state.messages);
  }
});

test("corrupt records, invalid message shapes and unsupported versions fail explicitly", async (t) => {
  const f = await fixture(t);
  const agent = await f.agent();
  await openSession(agent, f.workspace, f.storage);
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
    await assert.rejects(openSession(await f.agent(), f.workspace, f.storage), /session|message/i);
    assert.equal(await readFile(file, "utf8"), contents);
  }
});

test("bad or dangling current pointers never silently create a new session", async (t) => {
  const f = await fixture(t);
  const agent = await f.agent();
  await openSession(agent, f.workspace, f.storage);
  for (const pointer of [
    "{",
    '{"id":"../../outside"}',
    '{"id":"00000000-0000-4000-8000-000000000000"}',
  ]) {
    await writeFile(join(f.directory, "current.json"), pointer);
    await assert.rejects(openSession(await f.agent(), f.workspace, f.storage));
    assert.equal(await readFile(join(f.directory, "current.json"), "utf8"), pointer);
  }
});

test("model errors and cancellation persist messages before prompt settles", async (t) => {
  const f = await fixture(t);
  const agent = await f.agent();
  const faux = createFauxCore({ tokensPerSecond: 100000 });
  faux.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "Unavailable" }),
    fauxAssistantMessage("Long response ".repeat(100)),
  ]);
  agent.streamFunction = faux.streamSimple;
  const session = await openSession(agent, f.workspace, f.storage);
  await assert.rejects(session.prompt("Fail"), /Unavailable/);
  agent.subscribe((event) => {
    if (event.type === "message_update") agent.abort();
  });
  await assert.rejects(session.prompt("Cancel"), /aborted/i);
  const next = await f.agent();
  await openSession(next, f.workspace, f.storage);
  assert.deepEqual(next.state.messages, agent.state.messages);
});

test("write failures abort execution and block further prompts until reset", async (t) => {
  const f = await fixture(t);
  const agent = await f.agent();
  const faux = createFauxCore({});
  faux.setResponses([fauxAssistantMessage("After reset")]);
  agent.streamFunction = faux.streamSimple;
  const session = await openSession(agent, f.workspace, f.storage);
  const file = join(f.directory, `${agent.sessionId}.jsonl`);
  await rename(file, `${file}.backup`);
  await mkdir(file);
  await assert.rejects(session.prompt("Cannot save"), /Session write failed/);
  assert.equal(agent.state.isStreaming, false);
  await assert.rejects(session.prompt("Still blocked"), /Session write failed/);
  await session.reset();
  faux.setResponses([fauxAssistantMessage("After reset")]);
  await session.prompt("Working again");
  assert.equal(agent.state.errorMessage, undefined);
});

test("failed reset and resume preserve the active in-memory conversation", async (t) => {
  const f = await fixture(t);
  const agent = await f.agent();
  const session = await openSession(agent, f.workspace, f.storage);
  const before = structuredClone(agent.state.messages);
  const id = agent.sessionId;
  await assert.rejects(session.resume("../outside"), /Invalid session ID/);
  await assert.rejects(session.resume("00000000-0000-4000-8000-000000000000"), /ENOENT/);
  const pointer = join(f.directory, "current.json");
  await rm(pointer);
  await mkdir(pointer);
  await assert.rejects(session.reset());
  assert.equal(agent.sessionId, id);
  assert.deepEqual(agent.state.messages, before);
});

test("session operations reject overlapping prompts and switches", async (t) => {
  const f = await fixture(t);
  const agent = await f.agent();
  const faux = createFauxCore({});
  faux.setResponses([fauxAssistantMessage("Answer")]);
  agent.streamFunction = faux.streamSimple;
  const session = await openSession(agent, f.workspace, f.storage);
  const prompt = session.prompt("Question");
  await assert.rejects(session.reset(), /busy/);
  await assert.rejects(session.resume(agent.sessionId ?? ""), /busy/);
  await assert.rejects(session.prompt("Overlap"), /busy/);
  await prompt;
});
