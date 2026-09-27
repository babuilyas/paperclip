import type { UIAdapterModule } from "../types";
import { parseClaudeStdoutLine, buildClaudeOllamaConfig } from "@paperclipai/adapter-claude-ollama-local/ui";
import { ClaudeOllamaConfigFields } from "./config-fields";

export const claudeOllamaLocalUIAdapter: UIAdapterModule = {
  type: "claude_ollama_local",
  label: "Claude Code (Ollama)",
  parseStdoutLine: parseClaudeStdoutLine,
  ConfigFields: ClaudeOllamaConfigFields,
  buildAdapterConfig: buildClaudeOllamaConfig,
};