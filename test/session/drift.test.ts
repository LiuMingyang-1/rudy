import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { fixture } from "./fixture.ts";

test("resumed sessions declare tool changes on the next request", async (t) => {
  const f = await fixture(t);
  const first = await f.agent();
  const faux = createFauxCore({});
  faux.setResponses([fauxAssistantMessage("Old answer")]);
  first.streamFunction = faux.streamSimple;
  const session = await f.open(first);
  await session.prompt("Old question");
  const next = await f.agent();
  const extra: AgentTool = {
    name: "extra_tool",
    label: "Extra tool",
    description: "A test-only tool.",
    parameters: Type.Object({}),
    execute: async () => ({ content: [], details: {} }),
  };
  next.state.tools = [...next.state.tools.filter((tool) => tool.name !== "list_files"), extra];
  let captured: AgentMessage[] = [];
  const followup = createFauxCore({});
  followup.setResponses([
    (context) => {
      captured = [...context.messages];
      return fauxAssistantMessage("New answer");
    },
  ]);
  next.streamFunction = followup.streamSimple;
  const resumed = await f.open(next);
  await resumed.prompt("New question");
  const drift = captured.find(
    (message) =>
      message.role === "system" && message.toolsAdded?.some((tool) => tool.name === "extra_tool"),
  );
  assert.ok(drift?.role === "system");
  assert.deepEqual(
    drift.toolsRemoved?.map((tool) => tool.name),
    ["list_files"],
  );
});
