export const OLLAMA_BASE_URL = "http://localhost:11434";

/**
 * Env vars this adapter forces onto every claude invocation so the Claude
 * Code CLI talks to the local Ollama server's Anthropic-compatible API
 * instead of Anthropic. These win over host env and config env.
 */
export const OLLAMA_FORCED_ENV: Record<string, string> = {
  ANTHROPIC_BASE_URL: OLLAMA_BASE_URL,
  ANTHROPIC_AUTH_TOKEN: "ollama",
  // Empty API key is part of the documented Ollama setup: the CLI treats an
  // empty key as unset and falls through to the auth token.
  ANTHROPIC_API_KEY: "",
};

export const OLLAMA_FORCED_ENV_KEYS: readonly string[] = Object.keys(OLLAMA_FORCED_ENV);

/**
 * Env defaults for every claude invocation. Unlike OLLAMA_FORCED_ENV, config
 * env and host env override these.
 *
 * The Claude CLI retries a 429 up to 10 times with exponential backoff and
 * only prints the provider's message after the last attempt. An Ollama usage
 * limit is also a 429, so the run otherwise looks busy for minutes before it
 * fails as provider_quota. Paperclip schedules its own transient retries, so
 * a short CLI retry budget is enough.
 */
export const OLLAMA_DEFAULT_ENV: Record<string, string> = {
  CLAUDE_CODE_MAX_RETRIES: "2",
};

export function applyOllamaDefaultEnv(
  env: Record<string, string>,
  hostEnv: Record<string, string | undefined> = process.env,
): void {
  for (const [key, value] of Object.entries(OLLAMA_DEFAULT_ENV)) {
    if (key in env || hostEnv[key] !== undefined) continue;
    env[key] = value;
  }
}

/**
 * Resolve the Ollama model tag. No default: Ollama tags are disjoint from
 * Claude model IDs and a silent fallback would send a Claude ID to Ollama.
 */
export function resolveClaudeOllamaModel(
  model: unknown,
  env: Record<string, unknown> = {},
): string {
  const configured = typeof model === "string" ? model.trim() : "";
  if (configured) return configured;
  const environmentModel = typeof env.ANTHROPIC_MODEL === "string" ? env.ANTHROPIC_MODEL.trim() : "";
  return environmentModel;
}

export const type = "claude_ollama_local";

export const label = "Claude Code (Ollama)";

export const SANDBOX_INSTALL_COMMAND = "npm install -g @anthropic-ai/claude-code";

/** Static fallback is intentionally empty: discovery from the Ollama server is the source of truth. */
export const models: { id: string; label: string }[] = [];

export const agentConfigurationDoc = `# claude_ollama_local agent configuration

Adapter: claude_ollama_local

Runs the Claude Code CLI against a local Ollama server. The adapter forces ANTHROPIC_BASE_URL=${OLLAMA_BASE_URL}, ANTHROPIC_AUTH_TOKEN=ollama, and ANTHROPIC_API_KEY="" on every run; these keys cannot be overridden through config env.

Core fields:
- model (string, required): Ollama model tag, e.g. qwen3-coder:latest. Falls back to ANTHROPIC_MODEL when unset. A run with no model fails with claude_ollama_model_missing. List installed tags with \`ollama list\` or pull one with \`ollama pull <tag>\`.
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file injected at runtime
- effort (string, optional): reasoning effort passed via --effort (low|medium|high); support depends on the Ollama model
- chrome (boolean, optional): pass --chrome when running Claude
- promptTemplate (string, optional): run prompt template
- maxTurnsPerRun (number, optional): max turns for one run
- dangerouslySkipPermissions (boolean, optional, default true): allow non-interactive Claude runs to proceed without approval prompts. Local and remote targets receive --dangerously-skip-permissions for all built-in and connected tools. Managed sandbox targets also identify themselves to Claude so root container launches support bypass. Non-sandbox root processes must run Claude as a non-root user; Paperclip does not silently downgrade the requested mode.
- command (string, optional): defaults to "claude"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables (except the forced Ollama keys above)
- workspaceStrategy (object, optional): execution workspace strategy; currently supports { type: "git_worktree", baseRef?, branchTemplate?, worktreeParentDir? }
- workspaceRuntime (object, optional): reserved for workspace runtime metadata; workspace runtime services are manually controlled from the workspace UI and are not auto-started by heartbeats
- filesystemScope (string, optional): set to "workspace" to confine local CLI filesystem access with Bubblewrap. Off by default. The workspace and Claude config remain writable; other host paths are hidden.
- filesystemExtraPaths (array, optional): additional absolute host paths exposed inside the workspace sandbox. String entries are read-only; object entries use { path: "/absolute/path", access: "ro" | "rw" }.
- filesystemSandboxCommand (string, optional): Bubblewrap executable name or absolute path; defaults to "bwrap". Linux only.
- networkScope (string, optional): "deny" blocks all network egress; "allowlist" permits only networkAllowlist targets through Paperclip's HTTP(S) proxy. Off by default.
- networkAllowlist (string[], optional): exact hostnames, hostname:port entries, or origin URLs. Include "localhost:11434" so the Claude CLI can reach the Ollama server.

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- The Ollama server must be reachable at ${OLLAMA_BASE_URL} on the execution target, and the configured model must already be pulled there.
- Model discovery reads ${OLLAMA_BASE_URL}/v1/models; the model list is otherwise empty.
- Usage tokens come from the CLI's stream-json result event; cost is 0 for local runs and billing is recorded as provider "ollama".
- filesystemScope and networkScope are spawn-level confinement and are orthogonal to Claude permission flags. Both require Bubblewrap on the host. networkScope="allowlist" injects HTTP_PROXY/HTTPS_PROXY for the CLI while its private network namespace blocks direct sockets, so "localhost:11434" must be listed explicitly when the network is allowlisted.
- When Paperclip realizes a workspace/runtime for a run, it injects PAPERCLIP_WORKSPACE_* and PAPERCLIP_RUNTIME_* env vars for agent-side tooling.
`;