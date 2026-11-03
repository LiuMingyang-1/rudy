import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createRudy } from "../../src/agent.ts";
import { compactionDefaults } from "../../src/config.ts";
import { openSession } from "../../src/session/session.ts";
import { fixture } from "./fixture.ts";

test("compaction keeps the current system message instead of the stored one", async (t) => {
  const f = await fixture(t);
  const first = await f.create();
  first.faux.setResponses([fauxAssistantMessage("Done")]);
  await first.session.prompt("x".repeat(8000));
  const second = await createRudy({
    provider: "openai",
    model: "gpt-5.4",
    apiKey: "unused",
    workspace: f.workspace,
    contextWindow: 128000,
    maxTokens: 4096,
    ...compactionDefaults,
  });
  const system = second.state.messages[0];
  assert.ok(system?.role === "system");
  second.state.messages = [{ ...system, content: "New prompt" }, ...second.state.messages.slice(1)];
  second.streamFunction = first.faux.streamSimple;
  const resumed = await openSession(second, {
    workspace: f.workspace,
    storageRoot: f.storage,
    compaction: { ...compactionDefaults, compactionKeepRecentTokens: 100, maxTokens: 4096 },
  });
  let captured: AgentMessage[] = [];
  second.streamFunction = (model, context, options) => {
    captured = [...context.messages];
    return first.faux.streamSimple(model, context, options);
  };
  first.faux.setResponses([fauxAssistantMessage("Summary"), fauxAssistantMessage("Next answer")]);
  assert.equal(await resumed.compact(), true);
  assert.equal(second.state.messages[0]?.role, "system");
  assert.match(JSON.stringify(second.state.messages[0]?.content), /New prompt/);
  await resumed.prompt("Next question");
  assert.equal(captured[0]?.role, "system");
  assert.match(JSON.stringify(captured[0]?.content), /New prompt/);
  assert.doesNotMatch(JSON.stringify(captured), /You are Rudy/);
});
