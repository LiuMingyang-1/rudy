import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { fixture } from "./fixture.ts";

test("sessions restore full pi history and send it to the next model request", async (t) => {
  const f = await fixture(t);
  const agent = await f.agent();
  const faux = createFauxCore({});
  faux.setResponses([fauxAssistantMessage("First answer")]);
  agent.streamFunction = faux.streamSimple;
  const session = await f.open(agent);
  await session.prompt("First question");
  const history = structuredClone(agent.state.messages);
  const id = agent.sessionId;
  const next = await f.agent();
  const restored = await f.open(next);
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
  const session = await f.open(agent);
  const baseline = structuredClone(agent.state.messages);
  assert.deepEqual(await session.list(), { sessions: [], skipped: 0 });
  await session.prompt("Old question");
  const old = agent.sessionId;
  const oldHistory = structuredClone(agent.state.messages);
  await session.reset();
  assert.notEqual(agent.sessionId, old);
  assert.deepEqual(agent.state.messages, baseline);
  assert.equal((await session.list()).sessions.length, 1);
  await session.prompt("New question");
  const { sessions } = await session.list();
  assert.equal(sessions.length, 2);
  assert.ok(sessions[0].timestamp >= sessions[1].timestamp);
  assert.ok(old);
  await session.resume(old);
  assert.deepEqual(agent.state.messages, oldHistory);
  const next = await f.agent();
  await f.open(next);
  assert.equal(next.sessionId, old);
  assert.deepEqual(next.state.messages, oldHistory);
});

test("workspace real paths isolate histories and aliases share the same session", async (t) => {
  const f = await fixture(t);
  const first = await f.agent();
  await f.open(first);
  const alias = join(f.temporary, "alias");
  await symlink(f.workspace, alias);
  const same = await f.agent();
  await f.open(same, alias);
  assert.equal(same.sessionId, first.sessionId);
  const other = join(f.temporary, "other");
  await mkdir(other);
  const different = await f.agent();
  await f.open(different, other);
  assert.notEqual(different.sessionId, first.sessionId);
  await assert.rejects((await f.open(different, other)).resume(first.sessionId ?? ""), /ENOENT/);
});

test("resume lists only readable sessions and reports skipped files", async (t) => {
  const f = await fixture(t);
  const agent = await f.agent();
  const faux = createFauxCore({});
  faux.setResponses([fauxAssistantMessage("Old answer"), fauxAssistantMessage("New answer")]);
  agent.streamFunction = faux.streamSimple;
  const session = await f.open(agent);
  await session.prompt("Old question");
  const old = agent.sessionId;
  await session.reset();
  await session.prompt("New question");
  assert.ok(old);
  await appendFile(join(f.directory, `${old}.jsonl`), "{bad json}\n");
  const { sessions, skipped } = await session.list();
  assert.equal(skipped, 1);
  assert.deepEqual(
    sessions.map((summary) => summary.id),
    [agent.sessionId],
  );
  await session.resume(sessions[0].id);
  assert.equal(agent.sessionId, sessions[0].id);
});

test("session operations reject overlapping prompts and switches", async (t) => {
  const f = await fixture(t);
  const agent = await f.agent();
  const faux = createFauxCore({});
  faux.setResponses([fauxAssistantMessage("Answer")]);
  agent.streamFunction = faux.streamSimple;
  const session = await f.open(agent);
  const prompt = session.prompt("Question");
  await assert.rejects(session.reset(), /busy/);
  await assert.rejects(session.resume(agent.sessionId ?? ""), /busy/);
  await assert.rejects(session.prompt("Overlap"), /busy/);
  await prompt;
});
