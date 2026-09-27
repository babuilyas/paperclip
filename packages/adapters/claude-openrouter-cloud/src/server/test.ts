import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  asBoolean,
  asNumber,
  asStringArray,
  parseObject,
  ensurePathInEnv,
} from "@paperclipai/adapter-utils/server-utils";
import { ADAPTER_AUTH_MISSING_CHECK_CODE } from "@paperclipai/shared";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetDirectory,
  runAdapterExecutionTargetProcess,
  resolveAdapterExecutionTargetCwd,
  resolveAdapterExecutionTargetCommandForLogs,
} from "@paperclipai/adapter-utils/execution-target";
import {
  detectClaudeLoginRequired,
  isClaudeProviderQuotaError,
  isClaudeTransientUpstreamError,
  parseClaudeStreamJson,
} from "./parse.js";
import {
  claudeCliVersionAtLeast,
  claudeCommandLooksLike,
  claudeCommandSupportsEffortFlag,
  minimumClaudeCliVersionForModel,
  readClaudeCommandVersion,
} from "./cli-capabilities.js";
import { buildClaudeProbePermissionArgs, claudeSandboxPermissionEnv } from "./permissions.js";
import { prepareSandboxClaudeProbeRuntime } from "./claude-config.js";
import {
  applyOpenRouterDefaultEnv,
  buildOpenRouterForcedEnv,
  OPENROUTER_API_KEY_ENV,
  OPENROUTER_BASE_URL,
  OPENROUTER_FORCED_ENV_KEYS,
  resolveClaudeOpenRouterModel,
  resolveOpenRouterApiKey,
  SANDBOX_INSTALL_COMMAND,
} from "../index.js";
import {
  buildAdapterTestTargetCheck,
  buildClaudeLoginRequiredHint,
  logSandboxProbeDiagnostic,
} from "./probe-diagnostics.js";
import { buildLocalAdapterTestProbeEnv } from "./probe-env.js";
import { listClaudeOpenRouterModels } from "./models.js";

const OPENROUTER_KEY_CHECK_TIMEOUT_MS = 10_000;

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function localExecutablesMatch(
  trustedCommand: string | null,
  runtimeCommand: string | null,
): boolean {
  if (!trustedCommand || !runtimeCommand) return false;
  return trustedCommand === runtimeCommand;
}

type OpenRouterKeyState =
  | { status: "valid"; limitRemaining: number | null; isFreeTier: boolean }
  | { status: "invalid"; httpStatus: number }
  | { status: "unreachable" };

/**
 * Validate the key against OpenRouter's key endpoint. It reports the key's
 * remaining credit limit without spending any tokens.
 */
async function fetchOpenRouterKeyState(apiKey: string): Promise<OpenRouterKeyState> {
  try {
    const response = await fetch(`${OPENROUTER_BASE_URL}/v1/key`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(OPENROUTER_KEY_CHECK_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      return { status: "invalid", httpStatus: response.status };
    }
    if (!response.ok) return { status: "unreachable" };
    const payload = (await response.json()) as { data?: { limit_remaining?: unknown; is_free_tier?: unknown } };
    const limitRemaining = typeof payload.data?.limit_remaining === "number" ? payload.data.limit_remaining : null;
    return { status: "valid", limitRemaining, isFreeTier: payload.data?.is_free_tier === true };
  } catch {
    return { status: "unreachable" };
  }
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "claude");
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";
  const targetIsSandbox = target?.kind === "remote" && target.transport === "sandbox";
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const runId = `claude-openrouter-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  // Always name the target the Test probed, so a pass result never hides which
  // target it checked. A local probe reports the fixed host label.
  checks.push(
    buildAdapterTestTargetCheck({ targetIsRemote, environmentName: ctx.environmentName }),
  );

  try {
    await ensureAdapterExecutionTargetDirectory(runId, target, cwd, {
      cwd,
      env: {},
      createIfMissing: true,
    });
    checks.push({
      code: "claude_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "claude_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value !== "string") continue;
    // The OpenRouter endpoint and model-alias keys are adapter-owned; the
    // execute lane derives them itself, so the probe ignores them too.
    if (OPENROUTER_FORCED_ENV_KEYS.includes(key)) continue;
    env[key] = value;
  }
  // When probing a remote target, the Paperclip host's process.env does not
  // reflect what the agent will actually see at runtime. Only consider env
  // vars from the adapter config in that case; the probe itself will surface
  // any issues on the remote box.
  const considerHostEnv = !targetIsRemote && !config.managedAiConnection;
  const openRouterApiKey = resolveOpenRouterApiKey(env, considerHostEnv ? process.env : {});
  const configuredModel = resolveClaudeOpenRouterModel(
    config.model,
    considerHostEnv ? { ...process.env, ...env } : env,
  );
  applyOpenRouterDefaultEnv(env, considerHostEnv ? process.env : {});
  // Mirror the execute lane: point the CLI at OpenRouter with every model
  // alias on the configured model. For a local probe the allowlist in
  // buildLocalAdapterTestProbeEnv carries these into the deny-by-default
  // child env (the empty ANTHROPIC_API_KEY is dropped, which the CLI treats
  // as unset). A remote probe receives them directly through `env`.
  if (openRouterApiKey) {
    Object.assign(env, buildOpenRouterForcedEnv({ apiKey: openRouterApiKey, model: configuredModel }));
  }
  // For a local probe, resolve the trusted `claude` executable and a
  // deny-by-default child env from the shared builder, so a hostile caller
  // value can neither select the executable nor reach the child. A remote
  // target keeps the caller command and env; the remote transport owns its own
  // env sanitization.
  const localProbe = targetIsRemote
    ? null
    : await buildLocalAdapterTestProbeEnv({ callerEnv: env, trustedEnv: process.env });
  checks.push(
    ...(await prepareSandboxClaudeProbeRuntime({
      managedAiConnection: Boolean(config.managedAiConnection),
      runId,
      target,
      cwd,
      companyId: ctx.companyId,
      env,
      installCommand: SANDBOX_INSTALL_COMMAND,
      detectCommand: command,
      targetIsRemote,
      targetIsSandbox,
      helloProbeTimeoutSec: asNumber(config.helloProbeTimeoutSec, targetIsSandbox ? 90 : 45),
    })),
  );
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  let localRuntimeCommand: string | null = null;
  try {
    await ensureAdapterExecutionTargetCommandResolvable(command, target, cwd, runtimeEnv);
    if (!targetIsRemote) {
      localRuntimeCommand = await resolveAdapterExecutionTargetCommandForLogs(
        command,
        target,
        cwd,
        runtimeEnv,
      );
    }
    checks.push({
      code: "claude_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "claude_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  if (!openRouterApiKey) {
    checks.push({
      code: "openrouter_api_key_missing",
      level: "error",
      message: `No ${OPENROUTER_API_KEY_ENV} configured for this agent.`,
      hint: `Set ${OPENROUTER_API_KEY_ENV} in the agent environment, ideally bound to a company secret, then retry the Test.`,
    });
  } else {
    const keyState = await fetchOpenRouterKeyState(openRouterApiKey);
    if (keyState.status === "invalid") {
      checks.push({
        code: "openrouter_api_key_invalid",
        level: "error",
        message: `OpenRouter rejected the API key (HTTP ${keyState.httpStatus}).`,
        hint: `Check ${OPENROUTER_API_KEY_ENV} at openrouter.ai/keys, then retry the Test.`,
      });
    } else if (keyState.status === "unreachable") {
      checks.push({
        code: "openrouter_unreachable",
        level: "warn",
        message: `Could not verify the API key with ${OPENROUTER_BASE_URL}.`,
        hint: "Check network access to openrouter.ai. The hello probe still runs.",
      });
    } else if (keyState.limitRemaining !== null && keyState.limitRemaining <= 0) {
      checks.push({
        code: "openrouter_key_limit_exhausted",
        level: "warn",
        message: "The OpenRouter API key has no credit limit remaining.",
        hint: "Raise the key's limit or add credits at openrouter.ai, then retry the Test.",
      });
    } else {
      checks.push({
        code: "openrouter_api_key_valid",
        level: "info",
        message: keyState.limitRemaining === null
          ? "OpenRouter accepted the API key."
          : `OpenRouter accepted the API key (${keyState.limitRemaining} credits remaining on its limit).`,
      });
    }
  }

  if (!configuredModel) {
    checks.push({
      code: "openrouter_model_missing",
      level: "error",
      message: "No OpenRouter model configured for this agent.",
      hint: "Set the agent model to an OpenRouter model ID (e.g. qwen/qwen3-coder:free), then retry the Test.",
    });
  } else {
    const catalog = await listClaudeOpenRouterModels();
    if (catalog.length > 0 && !catalog.some((model) => model.id === configuredModel)) {
      checks.push({
        code: "openrouter_model_not_listed",
        level: "warn",
        message: `"${configuredModel}" is not in OpenRouter's catalog of models with tool calling.`,
        hint: "Claude Code needs tool calling. Check the model ID on openrouter.ai/models.",
      });
    } else if (catalog.length > 0) {
      checks.push({
        code: "openrouter_model_available",
        level: "info",
        message: `OpenRouter model "${configuredModel}" is available with tool calling.`,
      });
    }
  }

  const canRunProbe =
    checks.every(
      (check) =>
        check.code !== "claude_cwd_invalid" &&
        check.code !== "claude_command_unresolvable" &&
        check.code !== "claude_managed_config_dir_failed" &&
        check.code !== "openrouter_api_key_missing" &&
        check.code !== "openrouter_api_key_invalid" &&
        check.code !== "openrouter_model_missing",
    );
  let configuredModelIsCompatible = true;
  const minimumCliVersion =
    claudeCommandLooksLike(command, "claude")
      ? minimumClaudeCliVersionForModel(configuredModel)
      : null;
  const versionProbeCommand = localProbe?.command ?? (targetIsRemote ? command : null);
  const versionProbeMatchesRuntime = targetIsRemote || localExecutablesMatch(
    localProbe?.command ?? null,
    localRuntimeCommand,
  );
  if (
    canRunProbe &&
    minimumCliVersion &&
    versionProbeCommand &&
    !versionProbeMatchesRuntime
  ) {
    configuredModelIsCompatible = false;
    checks.push({
      code: "claude_cli_version_probe_mismatch",
      level: "warn",
      message:
        `Skipped ${configuredModel} readiness probing because the runtime PATH selects a different Claude executable than the trusted local Test probe.`,
      hint:
        `Ensure the runtime-selected Claude Code is ${minimumCliVersion} or newer. Execution will verify that exact executable before launch.`,
    });
  } else if (canRunProbe && minimumCliVersion && versionProbeCommand) {
    const versionProbeEnv = localProbe?.env ?? env;
    const detectedCliVersion = await readClaudeCommandVersion({
      runId,
      command: versionProbeCommand,
      target,
      cwd,
      env: versionProbeEnv,
      timeoutSec: 45,
      graceSec: 5,
    });
    if (
      !detectedCliVersion ||
      !claudeCliVersionAtLeast(detectedCliVersion, minimumCliVersion)
    ) {
      configuredModelIsCompatible = false;
      checks.push({
        code: "claude_cli_version_incompatible",
        level: "error",
        message: `${configuredModel} requires Claude Code ${minimumCliVersion} or newer on the CLI lane.`,
        detail: detectedCliVersion
          ? `Detected Claude Code ${detectedCliVersion}.`
          : "Could not determine the installed Claude Code version.",
        hint: "Upgrade Claude Code on the execution target, then retry the Test.",
      });
    }
  }

  if (canRunProbe && configuredModelIsCompatible) {
    if (!claudeCommandLooksLike(command, "claude")) {
      checks.push({
        code: "claude_hello_probe_skipped_custom_command",
        level: "info",
        message: "Skipped hello probe because command is not `claude`.",
        detail: command,
        hint: "Use the `claude` CLI command to run the automatic installation probe.",
      });
    } else if (localProbe && !localProbe.command) {
      // The trusted server PATH holds no `claude`, so the local probe cannot
      // run. Report a warn, never a silent pass.
      checks.push({
        code: "claude_hello_probe_skipped_unresolved_command",
        level: "warn",
        message: "Skipped the Claude hello probe because `claude` is not installed on the Paperclip host.",
        hint: "Install the `claude` CLI on the Paperclip host, then retry the Test.",
      });
    } else {
      const model = configuredModel;
      const effort = asString(config.effort, "").trim();
      const chrome = asBoolean(config.chrome, false);
      const maxTurns = asNumber(config.maxTurnsPerRun, 0);
      const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, true);
      Object.assign(env, claudeSandboxPermissionEnv({ dangerouslySkipPermissions, targetIsSandbox }));
      const extraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        if (fromExtraArgs.length > 0) return fromExtraArgs;
        return asStringArray(config.args);
      })();

      let effectiveEffort = effort;
      if (targetIsSandbox && effort) {
        const supportsEffort = await claudeCommandSupportsEffortFlag({
          runId,
          command,
          target,
          cwd,
          env,
          timeoutSec: 45,
          graceSec: 5,
        });
        if (supportsEffort === false) {
          effectiveEffort = "";
          checks.push({
            code: "claude_effort_flag_unsupported",
            level: "warn",
            message:
              "Claude CLI in the environment does not advertise --effort; the probe omitted the configured reasoning effort.",
            hint: "Upgrade the environment CLI/template to a newer Claude Code release to restore reasoning-effort control.",
          });
        }
      }

      const args = ["--print", "-", "--output-format", "stream-json", "--verbose"];
      if (config.managedAiConnection) args.push("--setting-sources", "user");
      args.push(...buildClaudeProbePermissionArgs({
        dangerouslySkipPermissions,
        targetIsRemote,
        localProcessUid: process.getuid?.() ?? null,
      }));
      if (chrome) args.push("--chrome");
      if (model) {
        args.push("--model", model);
      }
      if (effectiveEffort) args.push("--effort", effectiveEffort);
      if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
      if (extraArgs.length > 0) args.push(...extraArgs);

      // Sandbox bridges still add lease warmup and transport overhead, but
      // the standard-2 Cloudflare tier now probes fast enough that a 90s
      // budget leaves headroom without masking real hangs.
      const helloProbeTimeoutSec = Math.max(
        1,
        asNumber(config.helloProbeTimeoutSec, targetIsSandbox ? 90 : 45),
      );

      // A local probe uses the trusted resolved executable and the
      // deny-by-default child env. A remote probe uses the caller command and
      // env, because the remote transport owns its own env sanitization.
      const probeCommand = localProbe?.command ?? command;
      const probeEnv = localProbe ? localProbe.env : env;
      const probe = await runAdapterExecutionTargetProcess(
        runId,
        target,
        probeCommand,
        args,
        {
          cwd,
          env: probeEnv,
          timeoutSec: helloProbeTimeoutSec,
          graceSec: 5,
          stdin: "Respond with hello.",
          onLog: async () => {},
        },
      );

      const parsedStream = parseClaudeStreamJson(probe.stdout);
      const parsed = parsedStream.resultJson;
      const loginMeta = detectClaudeLoginRequired({
        parsed,
        stdout: probe.stdout,
        stderr: probe.stderr,
      });

      if (probe.timedOut) {
        checks.push({
          code: "claude_hello_probe_timed_out",
          level: "warn",
          message: "Claude hello probe timed out.",
          hint: "Retry the probe. If this persists, verify Claude can run `Respond with hello` against OpenRouter from this directory manually.",
        });
      } else if (loginMeta.requiresLogin) {
        // The raw probe output is untrusted. Log only the fixed context and the
        // allowlisted classification. Return only a fixed public message and a
        // safe hint.
        logSandboxProbeDiagnostic(
          "Claude CLI hello probe reported login required",
          "auth_required",
        );
        checks.push({
          code: "claude_hello_probe_auth_required",
          level: "warn",
          message: "Claude CLI is installed, but login is required.",
          hint: buildClaudeLoginRequiredHint(loginMeta.loginUrl),
        });
        if (targetIsSandbox) {
          // Emit the neutral canonical check so the user interface can decide
          // login eligibility from a stable code. The user interface does not
          // read the message text or the top-level status.
          checks.push({
            code: ADAPTER_AUTH_MISSING_CHECK_CODE,
            level: "warn",
            message: "This environment has no ready authentication for this adapter.",
            hint: "Provide credentials for this adapter, or start login in the environment.",
          });
        }
      } else if ((probe.exitCode ?? 1) === 0) {
        const summary = parsedStream.summary.trim();
        const hasHello = /\bhello\b/i.test(summary);
        if (!hasHello) {
          // The unexpected summary is untrusted probe output. Log only the fixed
          // context and the allowlisted classification. Keep the check text
          // fixed.
          logSandboxProbeDiagnostic(
            "Claude CLI hello probe returned unexpected output",
            "unexpected_output",
          );
        }
        checks.push({
          code: hasHello ? "claude_hello_probe_passed" : "claude_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello
            ? "Claude hello probe succeeded against OpenRouter."
            : "Claude probe ran but did not return `hello` as expected.",
          ...(hasHello
            ? {}
            : {
                hint: "Try the probe manually (`claude --print - --output-format stream-json --verbose --model <openrouter-model-id>`) and prompt `Respond with hello`.",
              }),
        });
      } else {
        // The failure diagnostic is untrusted. Log only the fixed context, the
        // allowlisted classification, and the safe exit code. Return only a
        // fixed public message and hint.
        logSandboxProbeDiagnostic("Claude CLI hello probe failed", "nonzero_exit", {
          exitCode: probe.exitCode ?? null,
        });
        const usageLimited = isClaudeProviderQuotaError({
          parsed,
          stdout: probe.stdout,
          stderr: probe.stderr,
        });
        const transient = isClaudeTransientUpstreamError({
          parsed,
          stdout: probe.stdout,
          stderr: probe.stderr,
        });
        checks.push(
          usageLimited
            ? {
                code: "claude_hello_probe_usage_limited",
                level: "warn",
                message: "Claude hello probe hit the subscription usage limit.",
                hint: "Authentication works; the account's usage window is exhausted. Wait for the limit to reset and re-run Test.",
              }
            : transient
              ? {
                  code: "claude_hello_probe_transient_upstream",
                  level: "warn",
                  message: "Claude hello probe hit a transient upstream error.",
                  hint: "This is usually temporary. Wait a moment and re-run Test.",
                }
              : {
                  code: "claude_hello_probe_failed",
                level: "error",
                message: "Claude hello probe failed.",
                hint: `Exit code ${probe.exitCode ?? "unknown"}. Verify ${OPENROUTER_API_KEY_ENV} and that OpenRouter serves the model, then run \`claude --print - --output-format stream-json --verbose --model <openrouter-model-id>\` manually in this directory and prompt \`Respond with hello\` to debug.`,
              },
        );
      }
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}