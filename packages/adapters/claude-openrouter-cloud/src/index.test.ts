import { describe, expect, it } from "vitest";
import {
  applyOpenRouterDefaultEnv,
  buildOpenRouterForcedEnv,
  OPENROUTER_BASE_URL,
  OPENROUTER_FORCED_ENV_KEYS,
  resolveClaudeOpenRouterModel,
  resolveOpenRouterApiKey,
  type,
  label,
  models,
} from "./index.js";

describe("claude_openrouter_cloud adapter metadata", () => {
  it("declares the openrouter adapter type and label", () => {
    expect(type).toBe("claude_openrouter_cloud");
    expect(label).toBe("Claude Code (OpenRouter)");
  });

  it("has an empty static model list; discovery is the source of truth", () => {
    expect(models).toEqual([]);
  });
});

describe("buildOpenRouterForcedEnv", () => {
  it("points the CLI at OpenRouter with the key as auth token and an empty API key", () => {
    expect(buildOpenRouterForcedEnv({ apiKey: "sk-or-test" })).toEqual({
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
      ANTHROPIC_AUTH_TOKEN: "sk-or-test",
      ANTHROPIC_API_KEY: "",
    });
    expect(OPENROUTER_BASE_URL).toBe("https://openrouter.ai/api");
  });

  it("maps every Claude model alias to the configured model", () => {
    const env = buildOpenRouterForcedEnv({ apiKey: "sk-or-test", model: " qwen/qwen3-coder:free " });
    for (const key of [
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "ANTHROPIC_DEFAULT_FABLE_MODEL",
      "CLAUDE_CODE_SUBAGENT_MODEL",
    ]) {
      expect(env[key]).toBe("qwen/qwen3-coder:free");
      expect(OPENROUTER_FORCED_ENV_KEYS).toContain(key);
    }
  });
});

describe("resolveOpenRouterApiKey", () => {
  it("prefers the run env over the host env", () => {
    expect(resolveOpenRouterApiKey({ OPENROUTER_API_KEY: " agent-key " }, { OPENROUTER_API_KEY: "host-key" }))
      .toBe("agent-key");
  });

  it("falls back to the host env, then to empty", () => {
    expect(resolveOpenRouterApiKey({}, { OPENROUTER_API_KEY: "host-key" })).toBe("host-key");
    expect(resolveOpenRouterApiKey({ OPENROUTER_API_KEY: "  " }, {})).toBe("");
  });
});

describe("resolveClaudeOpenRouterModel", () => {
  it.each([undefined, null, "", "  "])("has no default model (%j)", (model) => {
    expect(resolveClaudeOpenRouterModel(model)).toBe("");
  });

  it("resolves a configured OpenRouter model ID", () => {
    expect(resolveClaudeOpenRouterModel(" qwen/qwen3-coder:free ")).toBe("qwen/qwen3-coder:free");
  });

  it("falls back to OPENROUTER_MODEL, then ANTHROPIC_MODEL", () => {
    expect(resolveClaudeOpenRouterModel(undefined, { OPENROUTER_MODEL: " a/one ", ANTHROPIC_MODEL: "b/two" }))
      .toBe("a/one");
    expect(resolveClaudeOpenRouterModel(undefined, { ANTHROPIC_MODEL: " b/two " })).toBe("b/two");
  });

  it("keeps an explicit model ahead of the environment override", () => {
    expect(resolveClaudeOpenRouterModel("a/one", { OPENROUTER_MODEL: "other" })).toBe("a/one");
  });
});

describe("applyOpenRouterDefaultEnv", () => {
  it("caps the Claude CLI retry budget by default", () => {
    const env: Record<string, string> = {};
    applyOpenRouterDefaultEnv(env, {});
    expect(env.CLAUDE_CODE_MAX_RETRIES).toBe("2");
  });

  it("keeps a config or host override", () => {
    const configured: Record<string, string> = { CLAUDE_CODE_MAX_RETRIES: "5" };
    applyOpenRouterDefaultEnv(configured, {});
    expect(configured.CLAUDE_CODE_MAX_RETRIES).toBe("5");

    const hostOverride: Record<string, string> = {};
    applyOpenRouterDefaultEnv(hostOverride, { CLAUDE_CODE_MAX_RETRIES: "8" });
    expect(hostOverride.CLAUDE_CODE_MAX_RETRIES).toBeUndefined();
  });
});
