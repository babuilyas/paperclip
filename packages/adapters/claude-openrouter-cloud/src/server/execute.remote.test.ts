import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
import { OPENROUTER_BASE_URL, OPENROUTER_MODEL_ALIAS_ENV_KEYS } from "../index.js";

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  syncDirectoryToSsh,
  startAdapterExecutionTargetPaperclipBridge,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(async (_runId: string, _command: string, args: string[]): Promise<RunProcessResult> => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: args.includes("--version")
      ? "2.1.280 (Claude Code)\n"
      : [
          JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "qwen/qwen3-coder:free" }),
          JSON.stringify({ type: "assistant", session_id: "claude-session-1", message: { content: [{ type: "text", text: "hello" }] } }),
          JSON.stringify({ type: "result", session_id: "claude-session-1", result: "hello", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }),
        ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "ssh://fixture@127.0.0.1:2222/remote/workspace :: claude"),
  prepareWorkspaceForSshExecution: vi.fn(async () => ({ gitBacked: false })),
  restoreWorkspaceFromSshExecution: vi.fn(async () => undefined),
  syncDirectoryToSsh: vi.fn(async () => undefined),
  startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => ({
    env: {
      PAPERCLIP_API_URL: "http://127.0.0.1:4310",
      PAPERCLIP_API_KEY: "bridge-token",
      PAPERCLIP_API_BRIDGE_MODE: "queue_v1",
    },
    stop: async () => {},
  })),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureCommandResolvable,
    resolveCommandForLogs,
    runChildProcess,
  };
});

vi.mock("@paperclipai/adapter-utils/ssh", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/ssh")>(
    "@paperclipai/adapter-utils/ssh",
  );
  return {
    ...actual,
    prepareWorkspaceForSshExecution,
    restoreWorkspaceFromSshExecution,
    syncDirectoryToSsh,
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    startAdapterExecutionTargetPaperclipBridge,
  };
});

import { execute } from "./execute.js";
import { resetClaudeCliCapabilitiesCacheForTests } from "./cli-capabilities.js";

const OPENROUTER_MODEL = "qwen/qwen3-coder:free";
const OPENROUTER_TEST_KEY = "sk-or-test-key";

function sshTransport() {
  return {
    remoteExecution: {
      host: "127.0.0.1",
      port: 2222,
      username: "fixture",
      remoteWorkspacePath: "/remote/workspace",
      remoteCwd: "/remote/workspace",
      privateKey: "PRIVATE KEY",
      knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
      strictHostKeyChecking: true,
    },
  };
}

describe("claude openrouter remote execution", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    resetClaudeCliCapabilitiesCacheForTests();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("prepares the workspace, syncs Claude runtime assets, injects the OpenRouter env, and restores workspace changes for remote SSH execution", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-openrouter-remote-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const alternateWorkspaceDir = path.join(rootDir, "workspace-other");
    const instructionsPath = path.join(rootDir, "instructions.md");
    const managedRemoteWorkspace = "/remote/workspace/.paperclip-runtime/runs/run-1/workspace";
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(alternateWorkspaceDir, { recursive: true });
    await writeFile(instructionsPath, "Use the remote workspace.\n", "utf8");

    await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_openrouter_cloud",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "claude",
        model: OPENROUTER_MODEL,
        instructionsFilePath: instructionsPath,
        env: {
          OPENROUTER_API_KEY: OPENROUTER_TEST_KEY,
          QA_PROJECT_WORKSPACE_CWD: workspaceDir,
          RANDOM_WORKSPACE_CWD: workspaceDir,
          OTHER_ENV: workspaceDir,
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
          strategy: "git_worktree",
          workspaceId: "workspace-1",
          repoUrl: "https://github.com/paperclipai/paperclip.git",
          repoRef: "main",
          branchName: "feature/remote-claude",
          worktreePath: workspaceDir,
        },
        paperclipWorkspaces: [
          {
            workspaceId: "workspace-1",
            cwd: workspaceDir,
            repoUrl: "https://github.com/paperclipai/paperclip.git",
            repoRef: "main",
          },
          {
            workspaceId: "workspace-2",
            cwd: alternateWorkspaceDir,
            repoUrl: "https://github.com/paperclipai/paperclip.git",
            repoRef: "feature/other",
          },
        ],
      },
      executionTransport: sshTransport(),
      onLog: async () => {},
    });

    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledTimes(1);
    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledWith(expect.objectContaining({
      localDir: workspaceDir,
      remoteDir: managedRemoteWorkspace,
    }));
    // One sync per registered runtime asset: skills and mcp-config.
    expect(syncDirectoryToSsh).toHaveBeenCalledTimes(2);
    expect(syncDirectoryToSsh).toHaveBeenCalledWith(expect.objectContaining({
      remoteDir: `${managedRemoteWorkspace}/.paperclip-runtime/claude/skills`,
      followSymlinks: true,
    }));
    expect(syncDirectoryToSsh).toHaveBeenCalledWith(expect.objectContaining({
      remoteDir: `${managedRemoteWorkspace}/.paperclip-runtime/claude/mcp-config`,
      followSymlinks: true,
    }));
    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as
      | [string, string, string[], { env: Record<string, string>; remoteExecution?: { remoteCwd: string } | null }]
      | undefined;
    expect(call?.[2]).toEqual(expect.arrayContaining(["--model", OPENROUTER_MODEL]));
    expect(call?.[2]).toContain("--dangerously-skip-permissions");
    expect(call?.[2]).not.toContain("--allowedTools");
    expect(call?.[2]).toContain("--append-system-prompt-file");
    expect(call?.[2]).toContain(
      `${managedRemoteWorkspace}/.paperclip-runtime/claude/skills/agent-instructions.md`,
    );
    expect(call?.[2]).toContain("--add-dir");
    expect(call?.[2]).toContain(`${managedRemoteWorkspace}/.paperclip-runtime/claude/skills`);
    expect(call?.[3].env.PAPERCLIP_WORKSPACE_CWD).toBe(managedRemoteWorkspace);
    expect(call?.[3].env.PAPERCLIP_WORKSPACE_WORKTREE_PATH).toBeUndefined();
    expect(JSON.parse(call?.[3].env.PAPERCLIP_WORKSPACES_JSON ?? "[]")).toEqual([
      {
        workspaceId: "workspace-1",
        cwd: managedRemoteWorkspace,
        repoUrl: "https://github.com/paperclipai/paperclip.git",
        repoRef: "main",
      },
      {
        workspaceId: "workspace-2",
        repoUrl: "https://github.com/paperclipai/paperclip.git",
        repoRef: "feature/other",
      },
    ]);
    expect(call?.[3].env.PAPERCLIP_API_URL).toBe("http://127.0.0.1:4310");
    expect(call?.[3].env.PAPERCLIP_API_BRIDGE_MODE).toBe("queue_v1");
    expect(call?.[3].env.QA_PROJECT_WORKSPACE_CWD).toBe(managedRemoteWorkspace);
    expect(call?.[3].env.RANDOM_WORKSPACE_CWD).toBe(managedRemoteWorkspace);
    expect(call?.[3].env.OTHER_ENV).toBe(workspaceDir);
    // The OpenRouter endpoint env is adapter-owned and always present.
    expect(call?.[3].env.ANTHROPIC_BASE_URL).toBe(OPENROUTER_BASE_URL);
    expect(call?.[3].env.ANTHROPIC_AUTH_TOKEN).toBe(OPENROUTER_TEST_KEY);
    expect(call?.[3].env.ANTHROPIC_API_KEY).toBe("");
    for (const key of OPENROUTER_MODEL_ALIAS_ENV_KEYS) {
      expect(call?.[3].env[key]).toBe(OPENROUTER_MODEL);
    }
    expect(call?.[3].remoteExecution?.remoteCwd).toBe(managedRemoteWorkspace);
    expect(startAdapterExecutionTargetPaperclipBridge).toHaveBeenCalledTimes(1);
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledTimes(1);
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledWith(expect.objectContaining({
      localDir: workspaceDir,
      remoteDir: managedRemoteWorkspace,
    }));
  });

  it("does not resume saved Claude sessions for remote SSH execution without a matching remote identity", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-openrouter-remote-resume-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    await execute({
      runId: "run-ssh-no-resume",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_openrouter_cloud",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "12345678-1234-4abc-9def-123456789012",
        sessionParams: {
          sessionId: "12345678-1234-4abc-9def-123456789012",
          cwd: "/remote/workspace",
        },
        sessionDisplayId: "12345678-1234-4abc-9def-123456789012",
        taskKey: null,
      },
      config: {
        command: "claude",
        model: OPENROUTER_MODEL,
        env: { OPENROUTER_API_KEY: OPENROUTER_TEST_KEY },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTransport: sshTransport(),
      onLog: async () => {},
    });

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as [string, string, string[]] | undefined;
    expect(call?.[2]).not.toContain("--resume");
  });

  it("resumes saved Claude sessions for remote SSH execution when the remote identity matches", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-openrouter-remote-resume-match-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const managedRemoteWorkspace = "/remote/workspace/.paperclip-runtime/runs/run-ssh-resume/workspace";
    await mkdir(workspaceDir, { recursive: true });

    await execute({
      runId: "run-ssh-resume",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_openrouter_cloud",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "12345678-1234-4abc-9def-123456789012",
        sessionParams: {
          sessionId: "12345678-1234-4abc-9def-123456789012",
          cwd: managedRemoteWorkspace,
          remoteExecution: {
            transport: "ssh",
            host: "127.0.0.1",
            port: 2222,
            username: "fixture",
            remoteCwd: managedRemoteWorkspace,
          },
        },
        sessionDisplayId: "12345678-1234-4abc-9def-123456789012",
        taskKey: null,
      },
      config: {
        command: "claude",
        model: OPENROUTER_MODEL,
        env: { OPENROUTER_API_KEY: OPENROUTER_TEST_KEY },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTransport: sshTransport(),
      onLog: async () => {},
    });

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as [string, string, string[]] | undefined;
    expect(call?.[2]).toContain("--resume");
    expect(call?.[2]).toContain("12345678-1234-4abc-9def-123456789012");
  });

  it("forwards the duplex_channel_lost transport code on the unparsed Claude result path", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-openrouter-remote-duplex-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    // The run-disposition seam sets `errorCode: "duplex_channel_lost"` on the
    // process result, and the CLI stdout has no parsed Claude result. This
    // drives `toAdapterResult` into the unparsed branch, which must forward the
    // transport code rather than drop it to a provider classification.
    runChildProcess.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "not a Claude JSON result\n",
      stderr:
        "[paperclip] The sandbox duplex control channel was lost (provider_exit) before the run completed.\n",
      pid: 123,
      startedAt: new Date().toISOString(),
      errorCode: "duplex_channel_lost",
    });

    const result = await execute({
      runId: "run-ssh-duplex-lost",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_openrouter_cloud",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "claude",
        model: OPENROUTER_MODEL,
        env: { OPENROUTER_API_KEY: OPENROUTER_TEST_KEY },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTransport: sshTransport(),
      onLog: async () => {},
    });

    expect(result.errorCode).toBe("duplex_channel_lost");
  });

  it("reports the run under the openrouter provider identity with metered billing", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-openrouter-billing-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    const result = await execute({
      runId: "run-openrouter-billing",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_openrouter_cloud",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "claude",
        model: OPENROUTER_MODEL,
        env: { OPENROUTER_API_KEY: OPENROUTER_TEST_KEY },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTransport: sshTransport(),
      onLog: async () => {},
    });

    expect(result.provider).toBe("openrouter");
    expect(result.biller).toBe("openrouter");
    expect(result.billingType).toBe("metered_api");
    expect(result.usage).toEqual({ inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 });
  });

  describe("CLI-lane model pass-through", () => {
    async function executeWithModel(prefix: string, config: Record<string, unknown>) {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), prefix));
      cleanupDirs.push(rootDir);
      const workspaceDir = path.join(rootDir, "workspace");
      await mkdir(workspaceDir, { recursive: true });

      const result = await execute({
        runId: "run-model-passthrough",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claude Coder",
          adapterType: "claude_openrouter_cloud",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: "claude",
          ...config,
          env: {
            OPENROUTER_API_KEY: OPENROUTER_TEST_KEY,
            ...((config.env as Record<string, string> | undefined) ?? {}),
          },
        },
        context: {
          paperclipWorkspace: {
            cwd: workspaceDir,
            source: "project_primary",
          },
        },
        executionTransport: sshTransport(),
        onLog: async () => {},
      });

      const call = runChildProcess.mock.calls.find((candidate) =>
        (candidate[2] as string[]).includes("--print"),
      ) as unknown as [string, string, string[]] | undefined;
      return { args: call?.[2] ?? [], result };
    }

    it.each(["qwen/qwen3-coder:free", "anthropic/claude-sonnet-4"])("passes %s as --model on the CLI lane", async (model) => {
      const { args } = await executeWithModel("paperclip-claude-openrouter-model-direct-", {
        model,
      });

      const modelFlag = args.indexOf("--model");
      expect(modelFlag).toBeGreaterThanOrEqual(0);
      expect(args[modelFlag + 1]).toBe(model);
    });

    it("drops config env attempts to retarget the OpenRouter endpoint and model-alias keys and keeps unrelated keys", async () => {
      vi.stubEnv("ANTHROPIC_BASE_URL", "https://evil.example");
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-host-key");

      const { args } = await executeWithModel("paperclip-claude-openrouter-env-config-", {
        model: OPENROUTER_MODEL,
        env: {
          ANTHROPIC_BASE_URL: "https://config.example",
          ANTHROPIC_AUTH_TOKEN: "config-token",
          ANTHROPIC_API_KEY: "config-key",
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "anthropic/claude-haiku-4.5",
          OTHER_ENV: "kept",
        },
      });

      const call = runChildProcess.mock.calls.find((candidate) =>
        (candidate[2] as string[]).includes("--print"),
      ) as unknown as [string, string, string[], { env: Record<string, string> }] | undefined;
      const spawnEnv = call?.[3].env ?? {};
      expect(spawnEnv.ANTHROPIC_BASE_URL).toBe(OPENROUTER_BASE_URL);
      expect(spawnEnv.ANTHROPIC_AUTH_TOKEN).toBe(OPENROUTER_TEST_KEY);
      expect(spawnEnv.ANTHROPIC_API_KEY).toBe("");
      expect(spawnEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(OPENROUTER_MODEL);
      expect(spawnEnv.OTHER_ENV).toBe("kept");
      expect(args).toContain("--print");
    });

    it("uses OPENROUTER_MODEL from the run env (agent, environment or project env) when no agent model is set", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-openrouter-env-model-"));
      cleanupDirs.push(rootDir);
      const workspaceDir = path.join(rootDir, "workspace");
      await mkdir(workspaceDir, { recursive: true });

      const result = await execute({
        runId: "run-env-model",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claude Coder",
          adapterType: "claude_openrouter_cloud",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: "claude",
          env: { OPENROUTER_API_KEY: OPENROUTER_TEST_KEY, OPENROUTER_MODEL },
        },
        context: {
          paperclipWorkspace: {
            cwd: workspaceDir,
            source: "project_primary",
          },
        },
        executionTransport: sshTransport(),
        onLog: async () => {},
      });

      expect(result.errorCode).not.toBe("claude_openrouter_model_missing");
      expect(runChildProcess).toHaveBeenCalledTimes(1);
      const call = runChildProcess.mock.calls[0] as unknown as
        | [string, string, string[], { env: Record<string, string> }]
        | undefined;
      expect(call?.[2]).toEqual(expect.arrayContaining(["--model", OPENROUTER_MODEL]));
      for (const key of OPENROUTER_MODEL_ALIAS_ENV_KEYS) {
        expect(call?.[3].env[key]).toBe(OPENROUTER_MODEL);
      }
    });

    it("fails with claude_openrouter_model_missing and never spawns when no model is configured", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-openrouter-no-model-"));
      cleanupDirs.push(rootDir);
      const workspaceDir = path.join(rootDir, "workspace");
      await mkdir(workspaceDir, { recursive: true });

      const result = await execute({
        runId: "run-no-model",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claude Coder",
          adapterType: "claude_openrouter_cloud",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: "claude",
          env: { OPENROUTER_API_KEY: OPENROUTER_TEST_KEY },
        },
        context: {
          paperclipWorkspace: {
            cwd: workspaceDir,
            source: "project_primary",
          },
        },
        executionTransport: sshTransport(),
        onLog: async () => {},
      });

      expect(result.errorCode).toBe("claude_openrouter_model_missing");
      expect(result.provider).toBe("openrouter");
      expect(result.biller).toBe("openrouter");
      expect(result.errorMessage).toContain("OpenRouter model ID");
      expect(runChildProcess).not.toHaveBeenCalled();
    });

    it("fails with claude_openrouter_api_key_missing and never spawns when no key is configured", async () => {
      // A remote target never reads the host key, so a stubbed host value
      // must not satisfy the check.
      vi.stubEnv("OPENROUTER_API_KEY", "sk-or-host-key");
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-openrouter-no-key-"));
      cleanupDirs.push(rootDir);
      const workspaceDir = path.join(rootDir, "workspace");
      await mkdir(workspaceDir, { recursive: true });

      const result = await execute({
        runId: "run-no-key",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claude Coder",
          adapterType: "claude_openrouter_cloud",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: "claude",
          model: OPENROUTER_MODEL,
        },
        context: {
          paperclipWorkspace: {
            cwd: workspaceDir,
            source: "project_primary",
          },
        },
        executionTransport: sshTransport(),
        onLog: async () => {},
      });

      expect(result.errorCode).toBe("claude_openrouter_api_key_missing");
      expect(result.provider).toBe("openrouter");
      expect(result.errorMessage).toContain("OPENROUTER_API_KEY");
      expect(result.errorMessage).not.toContain("sk-or-host-key");
      expect(runChildProcess.mock.calls.some((call) => (call[2] as string[]).includes("--print"))).toBe(false);
    });

    it.each([
      ["claude-fable-5-1", "2.1.251", "2.1.247"],
      ["claude-opus-5-5", "2.1.280", "2.1.279"],
    ])("rejects %s before launch below CLI %s", async (model, minimumVersion, detectedVersion) => {
      runChildProcess.mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: `${detectedVersion} (Claude Code)\n`,
        stderr: "",
        pid: 123,
        startedAt: new Date().toISOString(),
      });

      const { args, result } = await executeWithModel("paperclip-claude-openrouter-model-old-cli-", {
        model,
      });

      expect(args).toEqual([]);
      expect(result.errorCode).toBe("claude_cli_version_incompatible");
      expect(result.provider).toBe("openrouter");
      expect(result.biller).toBe("openrouter");
      expect(result.errorMessage).toContain(`${model} requires Claude Code ${minimumVersion} or newer`);
      expect(result.resultJson).toMatchObject({
        requiredClaudeCodeVersion: minimumVersion,
        detectedClaudeCodeVersion: detectedVersion,
      });
    });

    it("leaves compatibility checks to explicitly configured custom CLI wrappers", async () => {
      const { args, result } = await executeWithModel("paperclip-claude-openrouter-model-wrapper-", {
        command: "/opt/paperclip/claude-wrapper",
        model: OPENROUTER_MODEL,
      });

      expect(args).toContain("--model");
      expect(args).toContain(OPENROUTER_MODEL);
      expect(result.errorCode).not.toBe("claude_cli_version_incompatible");
      expect(runChildProcess.mock.calls.some((call) =>
        (call[2] as string[]).includes("--version"),
      )).toBe(false);
    });
  });

});