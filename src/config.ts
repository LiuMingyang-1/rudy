import { resolve } from "node:path";

export interface RudyConfig {
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey: string;
  workspace: string;
}

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
  return {
    provider,
    model: model || (provider === "anthropic" ? "claude-sonnet-4-6" : "gpt-5.4"),
    baseUrl,
    apiKey,
    workspace: resolve(env.RUDY_WORKSPACE?.trim() || "."),
  };
}
