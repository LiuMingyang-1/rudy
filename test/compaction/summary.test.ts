import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { generateSummary } from "../../src/compaction/summary.ts";
import { fixture, user } from "./fixture.ts";

test("summary retries share three attempts, quality retries once, and provider retries are disabled", async (t) => {
  const f = await fixture(t);
  const { agent, faux } = await f.create();
  const budgets: number[] = [];
  agent.streamFunction = (model, context, options) => {
    assert.equal(options?.maxRetries, 0);
    budgets.push(options?.maxTokens ?? 0);
    return faux.streamSimple(model, context, options);
  };
  faux.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 temporarily unavailable" }),
    fauxAssistantMessage("Cut", { stopReason: "length" }),
    fauxAssistantMessage("Complete"),
  ]);
  assert.equal(
    (await generateSummary(agent, agent.state.model, [user("history")], 100)).summary,
    "Complete",
  );
  assert.deepEqual(budgets, [100, 100, 200]);
  const before = faux.state.callCount;
  faux.setResponses([fauxAssistantMessage(""), fauxAssistantMessage("")]);
  await assert.rejects(generateSummary(agent, agent.state.model, [user("history")], 100), /empty/);
  assert.equal(faux.state.callCount - before, 2);
  for (const response of [
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 unauthorized" }),
    fauxAssistantMessage(fauxToolCall("read_file", { path: "a" }), { stopReason: "toolUse" }),
  ]) {
    const count = faux.state.callCount;
    faux.setResponses([response]);
    await assert.rejects(generateSummary(agent, agent.state.model, [user("history")], 100));
    assert.equal(faux.state.callCount, count + 1);
  }
  const count = faux.state.callCount;
  faux.setResponses(
    Array.from({ length: 3 }, () =>
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "503 temporarily unavailable",
      }),
    ),
  );
  await assert.rejects(generateSummary(agent, agent.state.model, [user("history")], 100), /503/);
  assert.equal(faux.state.callCount, count + 3);
});

test("unusable summaries and budgets leave the original context and file unchanged", async (t) => {
  const f = await fixture(t);
  const { agent, faux, session, file } = await f.create();
  faux.setResponses([fauxAssistantMessage("Done"), fauxAssistantMessage("x".repeat(20000))]);
  await session.prompt("x".repeat(8000));
  const before = await readFile(file, "utf8");
  const messages = [...agent.state.messages];
  await assert.rejects(session.compact(), /did not reduce/);
  assert.deepEqual(agent.state.messages, messages);
  assert.equal(await readFile(file, "utf8"), before);
  const count = faux.state.callCount;
  await assert.rejects(
    generateSummary(agent, { ...agent.state.model, contextWindow: 1000 }, messages, 8192),
    /input does not fit/,
  );
  assert.equal(faux.state.callCount, count);
  agent.streamFunction = (model, context, options) => {
    assert.equal(options?.maxTokens, 500);
    return faux.streamSimple(model, context, options);
  };
  faux.setResponses([
    fauxAssistantMessage("Cut", { stopReason: "length" }),
    fauxAssistantMessage("Complete"),
  ]);
  await generateSummary(agent, { ...agent.state.model, maxTokens: 500 }, [user("history")], 100000);
});
