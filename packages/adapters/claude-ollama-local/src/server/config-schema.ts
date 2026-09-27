import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "model",
        label: "Ollama model tag",
        type: "text",
        required: true,
        hint: "Ollama model tag, e.g. qwen3-coder:latest. Required. List installed tags with `ollama list` or pull one with `ollama pull <tag>`.",
      },
    ],
  };
}