import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildClaudeOllamaConfig } from "./build-config.js";

function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "claude_ollama_local",
    cwd: "",
    instructionsFilePath: "",
    promptTemplate: "",
    model: "qwen3-coder:latest",
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

describe("buildClaudeOllamaConfig", () => {
  it("never emits an engine key; the CLI lane is the only lane", () => {
    const config = buildClaudeOllamaConfig(makeValues({ claudeEngine: "cli" }));

    expect(config).not.toHaveProperty("engine");
    expect(config).not.toHaveProperty("agentCommand");
    expect(config).not.toHaveProperty("mode");
  });

  it("keeps the configured Ollama model tag", () => {
    const config = buildClaudeOllamaConfig(makeValues({ model: "qwen3-coder:latest" }));

    expect(config.model).toBe("qwen3-coder:latest");
  });

  it("keeps user-scoped env bindings so the server resolves them at test time", () => {
    const config = buildClaudeOllamaConfig(
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
    const config = buildClaudeOllamaConfig(
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