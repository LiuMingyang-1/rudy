import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { createRudy } from "../../src/agent.ts";
import { loadConfig } from "../../src/config.ts";

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
        RUDY_CONTEXT_WINDOW: "200000",
        RUDY_MAX_TOKENS: "8192",
      }),
    );
    assert.equal(agent.state.model.contextWindow, 200000);
    assert.equal(agent.state.model.maxTokens, 8192);
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
