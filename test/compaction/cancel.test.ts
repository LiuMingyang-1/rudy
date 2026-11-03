import assert from "node:assert/strict";
import { mkdir, readFile, rename } from "node:fs/promises";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { fixture } from "./fixture.ts";

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
