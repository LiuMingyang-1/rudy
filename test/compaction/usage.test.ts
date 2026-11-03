import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { estimateMessage } from "../../src/compaction/tokens.ts";
import { fixture, noUsage } from "./fixture.ts";

test("valid API usage adds only subsequent messages; model changes invalidate the baseline", async (t) => {
  const f = await fixture(t, { compactionKeepRecentTokens: 1, maxTokens: 100 });
  const { agent, faux, session, file } = await f.create();
  agent.state.model = { ...agent.state.model, contextWindow: 20000 };
  const answer = fauxAssistantMessage("a".repeat(1200));
  answer.usage = {
    ...noUsage,
    input: 8000,
    cacheRead: 7000,
    cacheWrite: 400,
    output: 500,
    totalTokens: 999999,
  };
  agent.subscribe((event) => {
    if (
      event.type === "message_end" &&
      event.message.role === "assistant" &&
      event.message.content.some((part) => part.type === "text" && part.text === "a".repeat(1200))
    )
      event.message.usage = answer.usage;
  });
  faux.setResponses([answer, fauxAssistantMessage("Usage summary"), fauxAssistantMessage("Done")]);
  await session.prompt("First");
  await session.prompt("Next".repeat(200));
  assert.equal(faux.state.callCount, 3);
  const record = JSON.parse(
    (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .find((line) => line.includes('"type":"compaction"')) ?? "",
  );
  assert.equal(
    record.tokensBefore,
    15900 +
      estimateMessage({
        role: "user",
        content: [{ type: "text", text: "Next".repeat(200) }],
        timestamp: 1,
      }),
  );
  // Summary usage never becomes the conversation baseline, and old usage in the
  // retained tail is invalidated by replacing the context.
  faux.setResponses([fauxAssistantMessage("Next answer")]);
  await session.prompt("Small followup");
  assert.equal(faux.state.callCount, 4);
  await session.reset();
  faux.setResponses([answer, fauxAssistantMessage("No summary needed")]);
  await session.prompt("First");
  agent.state.model = { ...agent.state.model, id: "changed-model" };
  await session.prompt("Next".repeat(200));
  assert.equal(faux.state.callCount, 6);
});

test("zero, failed and restored usage fall back to local estimates", async (t) => {
  const f = await fixture(t, { compactionKeepRecentTokens: 1, maxTokens: 100 });
  const { agent, faux, session } = await f.create();
  agent.state.model = { ...agent.state.model, contextWindow: 20000 };
  agent.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      event.message.usage =
        event.message.stopReason === "error" ? { ...noUsage, input: 19999 } : noUsage;
    }
  });
  faux.setResponses([
    fauxAssistantMessage("a".repeat(3000)),
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 unauthorized" }),
    fauxAssistantMessage("Local estimate"),
  ]);
  await session.prompt("First");
  await assert.rejects(session.prompt("Failed"), /401/);
  await session.prompt("Continue");
  assert.equal(faux.state.callCount, 3);
  const restored = await f.create();
  restored.agent.state.model = { ...restored.agent.state.model, contextWindow: 20000 };
  restored.faux.setResponses([fauxAssistantMessage("Restored")]);
  await restored.session.prompt("Continue after restart");
  assert.equal(restored.faux.state.callCount, 1);
});
