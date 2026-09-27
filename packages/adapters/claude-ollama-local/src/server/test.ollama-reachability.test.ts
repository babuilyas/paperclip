import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { OLLAMA_BASE_URL } from "../index.js";

const {
  ensureAdapterExecutionTargetDirectory,
  ensureAdapterExecutionTargetCommandResolvable,
  maybeRunSandboxInstallCommand,
  runAdapterExecutionTargetProcess,
  describeAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
  probeResult,
} = vi.hoisted(() => {
  const probeResult: { value: { exitCode: number; stdout: string; stderr: string } } = {
    value: { exitCode: 1, stdout: "", stderr: "" },
  };
  return {
    probeResult,
    ensureAdapterExecutionTargetDirectory: vi.fn(async () => {}),
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => {}),
    maybeRunSandboxInstallCommand: vi.fn(async () => null),
    runAdapterExecutionTargetProcess: vi.fn(async () => ({
      exitCode: probeResult.value.exitCode,
      signal: null,
      timedOut: false,
      stdout: probeResult.value.stdout,
      stderr: probeResult.value.stderr,
      pid: 123,
      startedAt: new Date().toISOString(),
    })),
    describeAdapterExecutionTarget: vi.fn(() => "Daytona"),
    resolveAdapterExecutionTargetCwd: vi.fn(() => "/home/daytona/paperclip-workspace"),
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetDirectory,
    ensureAdapterExecutionTargetCommandResolvable,
    maybeRunSandboxInstallCommand,
    runAdapterExecutionTargetProcess,
    describeAdapterExecutionTarget,
    resolveAdapterExecutionTargetCwd,
  };
});

import { testEnvironment } from "./test.js";

const OLLAMA_MODEL = "qwen3-coder:latest";

const initLine =
  '{"type":"system","subtype":"init","cwd":"/home/daytona/paperclip-workspace","session_id":"abc","tools":["Bash","Read"]}';

const successStdout = [
  initLine,
  '{"type":"result","subtype":"success","is_error":false,"result":"hello","session_id":"abc"}',
].join("\n");

const sandboxTarget: AdapterExecutionTarget = {
  kind: "remote",
  transport: "sandbox",
  providerKey: "daytona",
  remoteCwd: "/home/daytona/paperclip-workspace",
  runner: {
    execute: async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: null,
      startedAt: new Date().toISOString(),
    }),
  },
};

function stubOllamaReachable(modelIds: string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: modelIds.map((id) => ({ id })) }),
    })),
  );
}

function stubOllamaDown() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
    }),
  );
}

beforeEach(() => {
  probeResult.value = { exitCode: 0, stdout: successStdout, stderr: "" };
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("ollama server reachability check", () => {
  it("fails a local Test with an error and skips the hello probe when the Ollama server is down", async () => {
    stubOllamaDown();

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_ollama_local",
      config: { command: "claude", model: OLLAMA_MODEL },
      executionTarget: null,
      environmentName: null,
    });

    expect(result.status).toBe("fail");
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "ollama_server_unreachable",
        level: "error",
        message: `Ollama server not reachable at ${OLLAMA_BASE_URL}.`,
        hint: "Start Ollama (`ollama serve`) and retry the Test.",
      }),
    );
    // An unreachable local server must not spawn a hello probe that can only
    // fail against it.
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("demotes an unreachable Ollama server to a warning for a remote target and still probes", async () => {
    // The Paperclip host cannot verify a remote target's localhost, so the
    // check must not fail the Test; the hello probe carries the real
    // verification on the remote box.
    stubOllamaDown();

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_ollama_local",
      config: { command: "claude", model: OLLAMA_MODEL },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "ollama_server_unreachable",
        level: "warn",
        hint: expect.stringContaining("ollama serve"),
      }),
    );
    expect(result.checks.some((check) => check.code === "ollama_model_available")).toBe(false);
    expect(result.checks.some((check) => check.code === "claude_hello_probe_passed")).toBe(true);
  });

  it("reports a reachable server and an available model as info", async () => {
    stubOllamaReachable([OLLAMA_MODEL]);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_ollama_local",
      config: { command: "claude", model: OLLAMA_MODEL },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "ollama_server_reachable",
        level: "info",
        message: `Ollama server is reachable at ${OLLAMA_BASE_URL}.`,
      }),
    );
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "ollama_model_available",
        level: "info",
        message: `Ollama model "${OLLAMA_MODEL}" is available.`,
      }),
    );
  });
});

describe("ollama model configuration checks", () => {
  it("warns and skips the hello probe when no model is configured", async () => {
    stubOllamaReachable([OLLAMA_MODEL]);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_ollama_local",
      config: { command: "claude" },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    expect(result.status).not.toBe("fail");
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "ollama_model_missing",
        level: "warn",
        message: "No Ollama model configured for this agent.",
        hint: "Set the agent model to an Ollama model tag (e.g. qwen3-coder:latest), or set OLLAMA_MODEL in the agent, environment or project env. Runs fail without a model from one of these.",
      }),
    );
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("warns with a pull hint when the configured model is not present on the server", async () => {
    stubOllamaReachable(["llama3.2:latest"]);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_ollama_local",
      config: { command: "claude", model: OLLAMA_MODEL },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "ollama_model_not_pulled",
        level: "warn",
        message: `Ollama model "${OLLAMA_MODEL}" is not present on the Ollama server.`,
        hint: `Run \`ollama pull ${OLLAMA_MODEL}\` on the Ollama host, then retry the Test.`,
      }),
    );
    // A missing pull is a warning, not a blocker: the hello probe still runs.
    expect(result.checks.some((check) => check.code === "claude_hello_probe_passed")).toBe(true);
  });

  it("treats a reachable server with an unusable model list as not-pulled, not unreachable", async () => {
    // A non-OK /v1/models answer still proves the server is up.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    );

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_ollama_local",
      config: { command: "claude", model: OLLAMA_MODEL },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    expect(result.checks.some((check) => check.code === "ollama_server_unreachable")).toBe(false);
    expect(result.checks.some((check) => check.code === "ollama_model_not_pulled")).toBe(true);
  });
});