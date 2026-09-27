import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildClaudeOpenRouterConfig } from "./build-config.js";

function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "claude_openrouter_cloud",
    cwd: "",
    instructionsFilePath: "",
    promptTemplate: "",
    model: "qwen/qwen3-coder:free",
    thinkingEffort: "",
    chrome: false,
    dangerouslySkipPermissions: true,
    claudeEngine: "auto",
    search: false,
    fastMode: false,
    dangerouslyBypassSandbox: false,
    command: "",
    args: "",
    extraArgs: "",
    envVars: "",
    envBindings: {},
    url: "",
    bootstrapPrompt: "",
    payloadTemplateJson: "",
    workspaceStrategyType: "project_primary",
    workspaceBaseRef: "",
    workspaceBranchTemplate: "",
    worktreeParentDir: "",
    runtimeServicesJson: "",
    maxTurnsPerRun: 1000,
    heartbeatEnabled: false,
    intervalSec: 300,
    ...overrides,
  };
}

describe("buildClaudeOpenRouterConfig", () => {
  it("never emits an engine key; the CLI lane is the only lane", () => {
    const config = buildClaudeOpenRouterConfig(makeValues({ claudeEngine: "cli" }));

    expect(config).not.toHaveProperty("engine");
    expect(config).not.toHaveProperty("agentCommand");
    expect(config).not.toHaveProperty("mode");
  });

  it("keeps the configured OpenRouter model ID", () => {
    const config = buildClaudeOpenRouterConfig(makeValues({ model: "qwen/qwen3-coder:free" }));

    expect(config.model).toBe("qwen/qwen3-coder:free");
  });

  it("keeps user-scoped env bindings so the server resolves them at test time", () => {
    const config = buildClaudeOpenRouterConfig(
      makeValues({
        envBindings: {
          GH_TOKEN: { type: "user_secret_ref", key: "github_token", version: "latest", required: true },
        },
      }),
    );

    expect(config.env).toEqual({
      GH_TOKEN: { type: "user_secret_ref", key: "github_token", version: "latest", required: true },
    });
  });

  it("keeps company secret and plain env bindings", () => {
    const config = buildClaudeOpenRouterConfig(
      makeValues({
        envBindings: {
          API_KEY: { type: "secret_ref", secretId: "11111111-1111-1111-1111-111111111111", version: "latest" },
          FLAG: { type: "plain", value: "on" },
        },
      }),
    );

    expect(config.env).toEqual({
      API_KEY: { type: "secret_ref", secretId: "11111111-1111-1111-1111-111111111111", version: "latest" },
      FLAG: { type: "plain", value: "on" },
    });
  });
});