import { describe, expect, it } from "vitest";
import {
  applyOllamaDefaultEnv,
  OLLAMA_BASE_URL,
  OLLAMA_FORCED_ENV,
  OLLAMA_FORCED_ENV_KEYS,
  resolveClaudeOllamaModel,
  type,
  label,
  models,
} from "./index.js";

describe("claude_ollama_local adapter metadata", () => {
  it("declares the ollama adapter type and label", () => {
    expect(type).toBe("claude_ollama_local");
    expect(label).toBe("Claude Code (Ollama)");
  });

  it("has an empty static model list; discovery is the source of truth", () => {
    expect(models).toEqual([]);
  });

  it("forces the local Ollama endpoint env", () => {
    expect(OLLAMA_FORCED_ENV).toEqual({
      ANTHROPIC_BASE_URL: "http://localhost:11434",
      ANTHROPIC_AUTH_TOKEN: "ollama",
      ANTHROPIC_API_KEY: "",
    });
    expect(OLLAMA_BASE_URL).toBe("http://localhost:11434");
    expect(OLLAMA_FORCED_ENV_KEYS).toEqual(
      expect.arrayContaining(["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]),
    );
  });
});

describe("resolveClaudeOllamaModel", () => {
  it.each([undefined, null, "", "  "])("has no default model (%j)", (model) => {
    expect(resolveClaudeOllamaModel(model)).toBe("");
  });

  it("resolves a configured Ollama tag", () => {
    expect(resolveClaudeOllamaModel(" qwen3-coder:latest ")).toBe("qwen3-coder:latest");
  });

  it("falls back to ANTHROPIC_MODEL when no model is configured", () => {
    expect(resolveClaudeOllamaModel(undefined, { ANTHROPIC_MODEL: " qwen3:32b " })).toBe("qwen3:32b");
  });

  it("prefers OLLAMA_MODEL over ANTHROPIC_MODEL when no model is configured", () => {
    expect(resolveClaudeOllamaModel(undefined, { OLLAMA_MODEL: " qwen3-coder:latest ", ANTHROPIC_MODEL: "other" }))
      .toBe("qwen3-coder:latest");
    expect(resolveClaudeOllamaModel("", { OLLAMA_MODEL: "  ", ANTHROPIC_MODEL: "qwen3:32b" })).toBe("qwen3:32b");
  });

  it("keeps an explicit model ahead of the environment override", () => {
    expect(resolveClaudeOllamaModel("qwen3-coder:latest", { ANTHROPIC_MODEL: "other" }))
      .toBe("qwen3-coder:latest");
  });
});
describe("applyOllamaDefaultEnv", () => {
  it("caps the Claude CLI retry budget by default", () => {
    const env: Record<string, string> = {};
    applyOllamaDefaultEnv(env, {});
    expect(env.CLAUDE_CODE_MAX_RETRIES).toBe("2");
  });

  it("keeps a config or host override", () => {
    const configured: Record<string, string> = { CLAUDE_CODE_MAX_RETRIES: "5" };
    applyOllamaDefaultEnv(configured, {});
    expect(configured.CLAUDE_CODE_MAX_RETRIES).toBe("5");

    const hostOverride: Record<string, string> = {};
    applyOllamaDefaultEnv(hostOverride, { CLAUDE_CODE_MAX_RETRIES: "8" });
    expect(hostOverride.CLAUDE_CODE_MAX_RETRIES).toBeUndefined();
  });
});
