import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";

test("configuration selects provider-specific defaults and credentials", () => {
  const openai = loadConfig({ OPENAI_API_KEY: "test-openai" });
  assert.equal(openai.provider, "openai");
  assert.equal(openai.model, "gpt-5.4");
  assert.equal(openai.contextWindow, 128000);
  assert.equal(openai.maxTokens, 4096);
  const anthropic = loadConfig({
    RUDY_PROVIDER: "anthropic",
    ANTHROPIC_API_KEY: "test-anthropic",
    RUDY_WORKSPACE: "test",
  });
  assert.equal(anthropic.model, "claude-sonnet-4-6");
  assert.equal(anthropic.apiKey, "test-anthropic");
  assert.equal(anthropic.workspace, resolve("test"));
});

test("configuration reads custom token limits and defaults empty values", () => {
  const config = loadConfig({
    RUDY_API_KEY: "unused",
    RUDY_CONTEXT_WINDOW: " 200000 ",
    RUDY_MAX_TOKENS: "8192",
  });
  assert.equal(config.contextWindow, 200000);
  assert.equal(config.maxTokens, 8192);
  const empty = loadConfig({
    RUDY_API_KEY: "unused",
    RUDY_CONTEXT_WINDOW: " ",
    RUDY_MAX_TOKENS: "",
  });
  assert.equal(empty.contextWindow, 128000);
  assert.equal(empty.maxTokens, 4096);
});

test("configuration rejects invalid token limits", () => {
  for (const name of ["RUDY_CONTEXT_WINDOW", "RUDY_MAX_TOKENS"]) {
    for (const value of [
      "0",
      "-1",
      "1.5",
      "abc",
      "NaN",
      "Infinity",
      "1e5",
      "0x100",
      "9007199254740992",
    ]) {
      assert.throws(() => loadConfig({ RUDY_API_KEY: "unused", [name]: value }), {
        message: `${name} must be a positive safe integer.`,
      });
    }
    const config = loadConfig({ RUDY_API_KEY: "unused", [name]: "1" });
    assert.equal(name === "RUDY_CONTEXT_WINDOW" ? config.contextWindow : config.maxTokens, 1);
  }
});

test("configuration rejects custom providers without endpoints and missing credentials", () => {
  assert.throws(() => loadConfig({ RUDY_PROVIDER: "custom" }), /requires RUDY_BASE_URL/);
  assert.throws(() => loadConfig({}), /OPENAI_API_KEY/);
  assert.throws(
    () => loadConfig({ RUDY_PROVIDER: "anthropic", OPENAI_API_KEY: "wrong-provider" }),
    /ANTHROPIC_API_KEY/,
  );
});

test("configuration accepts a named compatible provider and preserves the base path", () => {
  const config = loadConfig({
    RUDY_PROVIDER: "my-gateway",
    RUDY_BASE_URL: " https://example.com/gateway/v1/ ",
    RUDY_MODEL: "custom-model",
    RUDY_API_KEY: "custom-key",
    OPENAI_API_KEY: "other-key",
  });
  assert.equal(config.provider, "my-gateway");
  assert.equal(config.baseUrl, "https://example.com/gateway/v1");
  assert.equal(config.model, "custom-model");
  assert.equal(config.apiKey, "custom-key");
});

test("custom endpoints require an explicit model and a valid HTTP(S) URL", () => {
  const env = { RUDY_API_KEY: "unused", RUDY_MODEL: "custom-model" };
  for (const baseUrl of [
    "bad-url",
    "file:///tmp/model",
    "https://u:p@example.com",
    "https://example.com?key=x",
    "https://example.com/#x",
  ]) {
    assert.throws(() => loadConfig({ ...env, RUDY_BASE_URL: baseUrl }), /RUDY_BASE_URL/);
  }
  assert.throws(
    () => loadConfig({ RUDY_API_KEY: "unused", RUDY_BASE_URL: "https://example.com/v1" }),
    /Set RUDY_MODEL/,
  );
});
