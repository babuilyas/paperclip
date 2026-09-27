export const OPENROUTER_BASE_URL = "https://openrouter.ai/api";

/** Env var that carries the OpenRouter API key, from agent config env or the host. */
export const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";

/** Model alias env vars the Claude CLI resolves for opus/sonnet/haiku/fable and subagents. */
export const OPENROUTER_MODEL_ALIAS_ENV_KEYS: readonly string[] = [
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
];

/**
 * Env vars this adapter owns on every claude invocation so the Claude Code
 * CLI talks to OpenRouter's Anthropic-compatible API with a single model.
 * Config env cannot set them; the adapter derives them from the OpenRouter
 * key and the configured model.
 */
export const OPENROUTER_FORCED_ENV_KEYS: readonly string[] = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  ...OPENROUTER_MODEL_ALIAS_ENV_KEYS,
];

/**
 * Build the forced endpoint env. The API key must be the empty string, not
 * unset: the CLI treats an empty key as unset and falls through to the auth
 * token, while an inherited real key would win over it. With a model, every
 * alias the CLI may pick (opus/sonnet/haiku/fable, subagents) maps to it.
 */
export function buildOpenRouterForcedEnv(input: {
  apiKey: string;
  model?: string | null;
}): Record<string, string> {
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: OPENROUTER_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: input.apiKey,
    ANTHROPIC_API_KEY: "",
  };
  const model = input.model?.trim();
  if (model) {
    for (const key of OPENROUTER_MODEL_ALIAS_ENV_KEYS) env[key] = model;
  }
  return env;
}

/** Read the OpenRouter key from the run env, then (for local targets) the host env. */
export function resolveOpenRouterApiKey(
  env: Record<string, unknown>,
  hostEnv: Record<string, string | undefined> = {},
): string {
  const fromEnv = env[OPENROUTER_API_KEY_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
  const fromHost = hostEnv[OPENROUTER_API_KEY_ENV];
  return typeof fromHost === "string" ? fromHost.trim() : "";
}

/**
 * Env defaults for every claude invocation. Unlike the forced keys, config
 * env and host env override these.
 *
 * The Claude CLI retries a 429 up to 10 times with exponential backoff and
 * only prints the provider's message after the last attempt, so a quota or
 * free-tier limit otherwise looks busy for minutes before it fails.
 * Paperclip schedules its own transient retries, so a short CLI retry budget
 * is enough.
 */
export const OPENROUTER_DEFAULT_ENV: Record<string, string> = {
  CLAUDE_CODE_MAX_RETRIES: "2",
};

export function applyOpenRouterDefaultEnv(
  env: Record<string, string>,
  hostEnv: Record<string, string | undefined> = process.env,
): void {
  for (const [key, value] of Object.entries(OPENROUTER_DEFAULT_ENV)) {
    if (key in env || hostEnv[key] !== undefined) continue;
    env[key] = value;
  }
}

/**
 * Resolve the OpenRouter model ID (e.g. anthropic/claude-sonnet-4 or
 * qwen/qwen3-coder:free). No default: a silent fallback would send a Claude
 * model ID that OpenRouter may bill differently or reject.
 */
export function resolveClaudeOpenRouterModel(
  model: unknown,
  env: Record<string, unknown> = {},
): string {
  const configured = typeof model === "string" ? model.trim() : "";
  if (configured) return configured;
  for (const key of ["OPENROUTER_MODEL", "ANTHROPIC_MODEL"]) {
    const value = env[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export const type = "claude_openrouter_cloud";

export const label = "Claude Code (OpenRouter)";

export const SANDBOX_INSTALL_COMMAND = "npm install -g @anthropic-ai/claude-code";

/** Static fallback is intentionally empty: discovery from OpenRouter is the source of truth. */
export const models: { id: string; label: string }[] = [];

export const agentConfigurationDoc = `# claude_openrouter_cloud agent configuration

Adapter: claude_openrouter_cloud

Runs the Claude Code CLI against OpenRouter's Anthropic-compatible API with one model. On every run the adapter sets ANTHROPIC_BASE_URL=${OPENROUTER_BASE_URL}, ANTHROPIC_AUTH_TOKEN=<OPENROUTER_API_KEY>, ANTHROPIC_API_KEY="", and maps ANTHROPIC_DEFAULT_OPUS_MODEL, ANTHROPIC_DEFAULT_SONNET_MODEL, ANTHROPIC_DEFAULT_HAIKU_MODEL, ANTHROPIC_DEFAULT_FABLE_MODEL and CLAUDE_CODE_SUBAGENT_MODEL to the configured model; these keys cannot be overridden through config env.

Core fields:
- model (string, optional): OpenRouter model ID, e.g. anthropic/claude-sonnet-4 or qwen/qwen3-coder:free. When unset, the run env's OPENROUTER_MODEL, then ANTHROPIC_MODEL, is used; set either on the agent, its environment or the project. A run with no model from any source fails with claude_openrouter_model_missing.
- env.OPENROUTER_API_KEY (string, required): OpenRouter API key. Bind it to a company secret rather than a plain value. For local targets the host OPENROUTER_API_KEY is used when config env has none. A run with no key fails with claude_openrouter_api_key_missing.
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file injected at runtime
- effort (string, optional): reasoning effort passed via --effort (low|medium|high); support depends on the OpenRouter model
- chrome (boolean, optional): pass --chrome when running Claude
- promptTemplate (string, optional): run prompt template
- maxTurnsPerRun (number, optional): max turns for one run
- dangerouslySkipPermissions (boolean, optional, default true): allow non-interactive Claude runs to proceed without approval prompts. Local and remote targets receive --dangerously-skip-permissions for all built-in and connected tools. Managed sandbox targets also identify themselves to Claude so root container launches support bypass. Non-sandbox root processes must run Claude as a non-root user; Paperclip does not silently downgrade the requested mode.
- command (string, optional): defaults to "claude"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables (except the forced keys above). CLAUDE_CODE_MAX_RETRIES defaults to 2.
- workspaceStrategy (object, optional): execution workspace strategy; currently supports { type: "git_worktree", baseRef?, branchTemplate?, worktreeParentDir? }
- workspaceRuntime (object, optional): reserved for workspace runtime metadata; workspace runtime services are manually controlled from the workspace UI and are not auto-started by heartbeats
- filesystemScope (string, optional): set to "workspace" to confine local CLI filesystem access with Bubblewrap. Off by default. The workspace and Claude config remain writable; other host paths are hidden.
- filesystemExtraPaths (array, optional): additional absolute host paths exposed inside the workspace sandbox. String entries are read-only; object entries use { path: "/absolute/path", access: "ro" | "rw" }.
- filesystemSandboxCommand (string, optional): Bubblewrap executable name or absolute path; defaults to "bwrap". Linux only.
- networkScope (string, optional): "deny" blocks all network egress; "allowlist" permits only networkAllowlist targets through Paperclip's HTTP(S) proxy. Off by default.
- networkAllowlist (string[], optional): exact hostnames, hostname:port entries, or origin URLs. Include "openrouter.ai" so the Claude CLI can reach OpenRouter.

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Model discovery reads ${OPENROUTER_BASE_URL}/v1/models. OpenRouter's Anthropic-compatible API works best with models that support tool calling.
- Usage tokens come from the CLI's stream-json result event and billing is recorded as provider "openrouter". The CLI prices only Claude model IDs, so reported cost may be 0 for other models; check the OpenRouter dashboard for spend.
- filesystemScope and networkScope are spawn-level confinement and are orthogonal to Claude permission flags. Both require Bubblewrap on the host. networkScope="allowlist" injects HTTP_PROXY/HTTPS_PROXY for the CLI while its private network namespace blocks direct sockets, so "openrouter.ai" must be listed explicitly when the network is allowlisted.
- When Paperclip realizes a workspace/runtime for a run, it injects PAPERCLIP_WORKSPACE_* and PAPERCLIP_RUNTIME_* env vars for agent-side tooling.
`;
