// Verifies model config schema parsing and validation behavior.
import { describe, expect, it } from "vitest";
import { ModelsConfigSchema } from "./zod-schema.core.js";

describe("ModelsConfigSchema", () => {
  it("accepts google-vertex as a model API from MODEL_APIS", () => {
    const result = ModelsConfigSchema.safeParse({
      providers: {
        "google-vertex": {
          baseUrl: "https://{location}-aiplatform.googleapis.com",
          api: "google-vertex",
          apiKey: "gcp-vertex-credentials",
          models: [
            {
              id: "gemini-2.5-pro",
              name: "Gemini 2.5 Pro",
              api: "google-vertex",
            },
          ],
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts provider-specific thinking level maps on model definitions", () => {
    const result = ModelsConfigSchema.safeParse({
      providers: {
        "microsoft-foundry": {
          baseUrl: "https://example.services.ai.azure.com/openai/v1",
          api: "openai-completions",
          models: [
            {
              id: "gpt-5.4",
              name: "gpt-5.4",
              reasoning: true,
              thinkingLevelMap: {
                off: "none",
                minimal: null,
                low: "low",
                medium: "medium",
                high: "high",
              },
              input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 16_384,
            },
          ],
        },
      },
    });

    expect(result.success).toBe(true);
  });
});
