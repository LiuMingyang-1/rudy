import { resolve } from "node:path";

export interface RudyConfig {
  provider: string;
  model: string;
  baseUrl?: string;
  contextWindow: number;
  maxTokens: number;
  compactionThreshold: number;
  compactionKeepRecentTokens: number;
  compactionMaxTokens: number;
  apiKey: string;
  workspace: string;
}

export const compactionDefaults = {
  compactionThreshold: 0.8,
  compactionKeepRecentTokens: 20000,
  compactionMaxTokens: 8192,
};

/** 验证启动配置，无需进行模型请求。 **/
export function loadConfig(env: NodeJS.ProcessEnv = process.env): RudyConfig {
  const provider = env.RUDY_PROVIDER?.trim() || "openai";
  const baseUrl = env.RUDY_BASE_URL?.trim().replace(/\/+$/, "") || undefined;
  if (baseUrl) {
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new Error("RUDY_BASE_URL must be a valid HTTP(S) base URL.");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("RUDY_BASE_URL must be HTTP(S), without credentials, query or fragment.");
    }
  } else if (provider !== "openai" && provider !== "anthropic") {
    throw new Error("Custom RUDY_PROVIDER requires RUDY_BASE_URL and RUDY_MODEL.");
  }
  const model = env.RUDY_MODEL?.trim();
  if (baseUrl && !model) {
    throw new Error("Set RUDY_MODEL to the model ID offered by your custom endpoint.");
  }
  const fallbackKey = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  const apiKey = env.RUDY_API_KEY?.trim() || env[fallbackKey]?.trim();
  if (!apiKey) {
    throw new Error(
      `Set RUDY_API_KEY or ${fallbackKey} in .env or your environment. See .env.example.`,
    );
  }
  const compactionThreshold = Number(
    env.RUDY_COMPACTION_THRESHOLD?.trim() || compactionDefaults.compactionThreshold,
  );
  if (!Number.isFinite(compactionThreshold) || compactionThreshold <= 0 || compactionThreshold >= 1)
    throw new Error("RUDY_COMPACTION_THRESHOLD must be greater than 0 and less than 1.");
  return {
    provider,
    model: model || (provider === "anthropic" ? "claude-sonnet-4-6" : "gpt-5.4"),
    baseUrl,
    contextWindow: positiveInteger(env, "RUDY_CONTEXT_WINDOW", 128000),
    maxTokens: positiveInteger(env, "RUDY_MAX_TOKENS", 4096),
    compactionThreshold,
    compactionKeepRecentTokens: positiveInteger(
      env,
      "RUDY_COMPACTION_KEEP_RECENT_TOKENS",
      compactionDefaults.compactionKeepRecentTokens,
    ),
    compactionMaxTokens: positiveInteger(
      env,
      "RUDY_COMPACTION_MAX_TOKENS",
      compactionDefaults.compactionMaxTokens,
    ),
    apiKey,
    workspace: resolve(env.RUDY_WORKSPACE?.trim() || "."),
  };
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name]?.trim();
  if (!value) return fallback;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return number;
}
