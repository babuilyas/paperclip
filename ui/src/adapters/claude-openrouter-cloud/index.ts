import type { UIAdapterModule } from "../types";
import { parseClaudeStdoutLine, buildClaudeOpenRouterConfig } from "@paperclipai/adapter-claude-openrouter-cloud/ui";
import { ClaudeOpenRouterConfigFields } from "./config-fields";

export const claudeOpenRouterCloudUIAdapter: UIAdapterModule = {
  type: "claude_openrouter_cloud",
  label: "Claude Code (OpenRouter)",
  parseStdoutLine: parseClaudeStdoutLine,
  ConfigFields: ClaudeOpenRouterConfigFields,
  buildAdapterConfig: buildClaudeOpenRouterConfig,
};