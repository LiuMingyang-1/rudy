import assert from "node:assert/strict";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { openSession } from "../../src/session/session.ts";
import { fixture } from "./fixture.ts";

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
