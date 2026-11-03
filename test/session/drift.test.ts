import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { createFauxCore, fauxAssistantMessage, getCurrentTools } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { fixture } from "./fixture.ts";

function withPrompt(agent: { state: { messages: AgentMessage[] } }, content: string): void {
  const system = agent.state.messages[0];
  assert.ok(system?.role === "system");
  agent.state.messages = [{ ...system, content }, ...agent.state.messages.slice(1)];
}

test("a changed prompt replaces the stored one on the next request", async (t) => {
  const f = await fixture(t);
  const first = await f.agent();
  const faux = createFauxCore({});
  faux.setResponses([fauxAssistantMessage("Old answer")]);
  first.streamFunction = faux.streamSimple;
  const session = await f.open(first);
  await session.prompt("Old question");
  const next = await f.agent();
  withPrompt(next, "New prompt");
  let captured: AgentMessage[] = [];
  const followup = createFauxCore({});
  followup.setResponses([
    (context) => {
      captured = [...context.messages];
      return fauxAssistantMessage("New answer");
    },
  ]);
  next.streamFunction = followup.streamSimple;
  await (await f.open(next)).prompt("New question");
  assert.equal(captured[0]?.role, "system");
  assert.match(JSON.stringify(captured[0]?.content), /New prompt/);
  assert.doesNotMatch(JSON.stringify(captured), /You are Rudy/);
});

test("resumed sessions declare the current tools, ignoring stored tool-change messages", async (t) => {
  const f = await fixture(t);
  const first = await f.agent();
  const faux = createFauxCore({});
  faux.setResponses([fauxAssistantMessage("Old answer")]);
  first.streamFunction = faux.streamSimple;
  const session = await f.open(first);
  await session.prompt("Old question");
  const second = await f.agent();
  const resumed = await f.open(second);
  const extra: AgentTool = {
    name: "extra_tool",
    label: "Extra tool",
    description: "A test-only tool.",
    parameters: Type.Object({}),
    execute: async () => ({ content: [], details: {} }),
  };
  second.state.tools = [...second.state.tools.filter((tool) => tool.name !== "list_files"), extra];
  const followup = createFauxCore({});
  followup.setResponses([fauxAssistantMessage("Second answer")]);
  second.streamFunction = followup.streamSimple;
  await resumed.prompt("Second question");
  const stored = await readFile(join(f.directory, `${second.sessionId}.jsonl`), "utf8");
  assert.match(stored, /"toolsRemoved":\[{"name":"list_files"}\]/);
  const third = await f.agent();
  let captured: AgentMessage[] = [];
  const last = createFauxCore({});
  last.setResponses([
    (context) => {
      captured = [...context.messages];
      return fauxAssistantMessage("Third answer");
    },
  ]);
  third.streamFunction = last.streamSimple;
  await (await f.open(third)).prompt("Third question");
  assert.ok(getCurrentTools(captured).some((tool) => tool.name === "list_files"));
  assert.ok(
    !captured.some(
      (message) =>
        message.role === "system" &&
        message.toolsRemoved?.some((tool) => tool.name === "list_files"),
    ),
  );
  assert.doesNotMatch(JSON.stringify(captured), /extra_tool/);
});

test("restore keeps stored system messages on disk without replaying them", async (t) => {
  const f = await fixture(t);
  const first = await f.agent();
  const faux = createFauxCore({});
  faux.setResponses([fauxAssistantMessage("Old answer")]);
  first.streamFunction = faux.streamSimple;
  const session = await f.open(first);
  await session.prompt("Old question");
  const file = join(f.directory, `${first.sessionId}.jsonl`);
  const before = await readFile(file, "utf8");
  const next = await f.agent();
  withPrompt(next, "New prompt");
  const followup = createFauxCore({});
  followup.setResponses([fauxAssistantMessage("New answer")]);
  next.streamFunction = followup.streamSimple;
  await (await f.open(next)).prompt("New question");
  const after = await readFile(file, "utf8");
  assert.ok(after.startsWith(before));
  const firstMessage = JSON.parse(after.trim().split("\n")[1]);
  assert.equal(firstMessage.type, "message");
  assert.equal(firstMessage.message.role, "system");
  assert.match(JSON.stringify(firstMessage.message.content), /You are Rudy/);
  assert.doesNotMatch(JSON.stringify(firstMessage.message.content), /New prompt/);
});
