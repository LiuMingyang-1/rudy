import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createRudy } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";

test("Rudy executes a tool and sends its result back before streaming the answer", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "rudy-agent-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, "notes.txt"), "Review the PR.");
  const agent = await createRudy({
    provider: "openai",
    model: "gpt-5.4",
    apiKey: "unused",
    workspace,
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
    apiKey: "unused",
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
    provider: "openai",
    model: "gpt-5.4",
    apiKey: "unused",
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
    provider: "openai",
    model: "gpt-5.4",
    apiKey: "unused",
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

for (const endpoint of [
  { provider: "my-gateway", base: "/gateway/v1", path: "/gateway/v1/chat/completions" },
  { provider: "openai", base: "/gateway/v1", path: "/gateway/v1/chat/completions" },
  { provider: "anthropic", base: "/gateway", path: "/gateway/v1/messages" },
]) {
  test(`custom ${endpoint.provider} endpoint receives the configured path, model and credential`, {
    timeout: 10000,
  }, async (t) => {
    const requests: { path: string | undefined; credential: unknown; body: string }[] = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push({
        path: request.url,
        credential: request.headers.authorization ?? request.headers["x-api-key"],
        body,
      });
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      if (endpoint.provider === "anthropic") {
        const events = [
          {
            type: "message_start",
            message: {
              id: "local-response",
              type: "message",
              role: "assistant",
              content: [],
              model: "my-local-model",
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Custom endpoint works." },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 4 },
          },
          { type: "message_stop" },
        ];
        for (const event of events)
          response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        response.end();
        return;
      }
      const chunk = {
        id: "local-response",
        object: "chat.completion.chunk",
        created: 0,
        model: "my-local-model",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Custom endpoint works." },
            finish_reason: null,
          },
        ],
      };
      response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      response.write(
        `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    });
    t.after(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const agent = await createRudy(
      loadConfig({
        RUDY_PROVIDER: endpoint.provider,
        RUDY_BASE_URL: `http://127.0.0.1:${address.port}${endpoint.base}/`,
        RUDY_MODEL: "my-local-model",
        RUDY_API_KEY: "local-test-key",
      }),
    );
    await agent.prompt("Hello");
    assert.equal(agent.state.errorMessage, undefined);
    assert.equal(requests.length, 1);
    assert.equal(new URL(requests[0].path ?? "", "http://localhost").pathname, endpoint.path);
    assert.equal(
      requests[0].credential,
      endpoint.provider === "anthropic" ? "local-test-key" : "Bearer local-test-key",
    );
    assert.match(requests[0].body, /"model":"my-local-model"/);
    const answer = agent.state.messages.at(-1);
    assert.equal(answer?.role, "assistant");
    assert.deepEqual(answer.content, [{ type: "text", text: "Custom endpoint works." }]);
  });
}
