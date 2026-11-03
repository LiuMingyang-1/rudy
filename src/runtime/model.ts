import { createProvider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { RudyConfig } from "../config.ts";

export function createRudyProvider(config: RudyConfig) {
  if (!config.baseUrl) {
    return config.provider === "anthropic" ? anthropicProvider() : openaiProvider();
  }
  const api = config.provider === "anthropic" ? "anthropic-messages" : "openai-completions";
  return createProvider({
    id: config.provider,
    baseUrl: config.baseUrl,
    auth: {
      apiKey: {
        name: "Rudy API key",
        resolve: async () => ({ auth: { apiKey: config.apiKey } }),
      },
    },
    models: [
      {
        id: config.model,
        name: config.model,
        provider: config.provider,
        baseUrl: config.baseUrl,
        api,
        input: ["text"],
        reasoning: false,
        // Custom endpoints have no catalog metadata; these are local defaults, not price estimates.
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: config.contextWindow,
        maxTokens: Math.min(
          config.contextWindow,
          Math.max(config.maxTokens, config.compactionMaxTokens ?? 8192),
        ),
      },
    ],
    api: api === "anthropic-messages" ? anthropicMessagesApi() : openAICompletionsApi(),
  });
}
