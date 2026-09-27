import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "model",
        label: "OpenRouter model ID",
        type: "text",
        required: true,
        hint: "OpenRouter model ID, e.g. anthropic/claude-sonnet-4 or qwen/qwen3-coder:free. Required. Set OPENROUTER_API_KEY in the agent environment, ideally bound to a secret.",
      },
    ],
  };
}
