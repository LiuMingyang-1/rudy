import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createRudy } from "../../src/agent.ts";
import { compactionDefaults } from "../../src/config.ts";

test("Rudy executes a tool and sends its result back before streaming the answer", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "rudy-agent-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, "notes.txt"), "Review the PR.");
  const agent = await createRudy({
    provider: "openai",
    model: "gpt-5.4",
    apiKey: "unused",
    workspace,
    contextWindow: 128000,
    maxTokens: 4096,
    ...compactionDefaults,
  });
  const faux = createFauxCore({});
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read_file", { path: "notes.txt" }), {
      stopReason: "toolUse",
    }),
    (context) => {
      const result = context.messages.at(-1);
      assert.equal(result?.role, "toolResult");
      assert.deepEqual(result.content, [{ type: "text", text: "Review the PR." }]);
      return fauxAssistantMessage("You need to review the PR.");
    },
  ]);
  agent.streamFunction = faux.streamSimple;
  let output = "";
  agent.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      output += event.assistantMessageEvent.delta;
    }
  });
  await agent.prompt("What do my notes say?");
  assert.equal(agent.state.errorMessage, undefined);
  assert.equal(output, "You need to review the PR.");
  assert.equal(faux.state.callCount, 2);
});

test("Rudy returns denied file access to the model as a tool failure", async () => {
  const agent = await createRudy({
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    contextWindow: 128000,
    maxTokens: 4096,
    apiKey: "unused",
    ...compactionDefaults,
    workspace: ".",
  });
  const faux = createFauxCore({});
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read_file", { path: "../outside.txt" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("That path is outside my workspace."),
  ]);
  agent.streamFunction = faux.streamSimple;
  await agent.prompt("Read outside the workspace.");
  const result = agent.state.messages.find((message) => message.role === "toolResult");
  assert.equal(result?.role, "toolResult");
  assert.equal(result.isError, true);
  assert.equal(agent.state.errorMessage, undefined);
});

test("Rudy exposes model failures and rejects unknown model configuration", async () => {
  const config = {
    contextWindow: 128000,
    maxTokens: 4096,
    provider: "openai",
    model: "gpt-5.4",
    apiKey: "unused",
    ...compactionDefaults,
    workspace: ".",
  } as const;
  const agent = await createRudy(config);
  const faux = createFauxCore({});
  faux.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "Unavailable" }),
  ]);
  agent.streamFunction = faux.streamSimple;
  await agent.prompt("Hello");
  assert.equal(agent.state.errorMessage, "Unavailable");
  await assert.rejects(createRudy({ ...config, model: "unknown-rudy-model" }), /Unknown model/);
});

test("Rudy can cancel an active streamed response", async () => {
  const agent = await createRudy({
    contextWindow: 128000,
    maxTokens: 4096,
    provider: "openai",
    model: "gpt-5.4",
    apiKey: "unused",
    ...compactionDefaults,
    workspace: ".",
  });
  const faux = createFauxCore({ tokensPerSecond: 100000 });
  faux.setResponses([fauxAssistantMessage("unfinished response ".repeat(100))]);
  agent.streamFunction = faux.streamSimple;
  agent.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      agent.abort();
    }
  });
  await agent.prompt("Start a long response.");
  assert.match(agent.state.errorMessage ?? "", /aborted/i);
  assert.equal(agent.state.isStreaming, false);
});
