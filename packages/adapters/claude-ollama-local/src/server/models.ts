import type { AdapterModel } from "@paperclipai/adapter-utils";
import { OLLAMA_BASE_URL } from "../index.js";

const OLLAMA_MODELS_ENDPOINT = "/v1/models";
const OLLAMA_MODELS_TIMEOUT_MS = 5000;
const OLLAMA_MODELS_CACHE_TTL_MS = 60_000;

interface OllamaModelsCache {
  baseUrl: string;
  expiresAt: number;
  models: AdapterModel[];
}

let cached: OllamaModelsCache | null = null;

function dedupeModels(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const deduped: AdapterModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({ id, label: model.label.trim() || id });
  }
  return deduped;
}

async function fetchOllamaModels(baseUrl: string): Promise<AdapterModel[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OLLAMA_MODELS_TIMEOUT_MS);
  try {
    // Ollama's Anthropic-compatible endpoint serves /v1/models and needs no
    // auth headers for a local server.
    const response = await fetch(`${baseUrl}${OLLAMA_MODELS_ENDPOINT}`, {
      signal: controller.signal,
    });
    if (!response.ok) return [];

    const payload = (await response.json()) as { data?: unknown };
    const data = Array.isArray(payload.data) ? payload.data : [];
    const models: AdapterModel[] = [];
    for (const item of data) {
      if (typeof item !== "object" || item === null) continue;
      const record = item as { id?: unknown; display_name?: unknown };
      if (typeof record.id !== "string" || record.id.trim().length === 0) continue;
      const displayName =
        typeof record.display_name === "string" && record.display_name.trim().length > 0
          ? record.display_name
          : record.id;
      models.push({
        id: record.id,
        label: displayName,
      });
    }
    return dedupeModels(models);
  } catch (error) {
    console.warn("[paperclip] Ollama model discovery failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function loadClaudeOllamaModels(options?: { forceRefresh?: boolean }): Promise<AdapterModel[]> {
  const now = Date.now();
  const baseUrl = OLLAMA_BASE_URL;
  if (
    options?.forceRefresh !== true &&
    cached &&
    cached.baseUrl === baseUrl &&
    cached.expiresAt > now
  ) {
    return cached.models;
  }

  const fetched = await fetchOllamaModels(baseUrl);
  cached = {
    baseUrl,
    expiresAt: now + OLLAMA_MODELS_CACHE_TTL_MS,
    models: fetched,
  };
  return fetched;
}

/**
 * Return the Ollama server's model list. The static fallback is empty:
 * Ollama tags are disjoint from Claude model IDs and a fallback would
 * mislead the operator, so discovery is the only source.
 */
export async function listClaudeOllamaModels(): Promise<AdapterModel[]> {
  return loadClaudeOllamaModels();
}

export async function refreshClaudeOllamaModels(): Promise<AdapterModel[]> {
  return loadClaudeOllamaModels({ forceRefresh: true });
}

export function resetClaudeOllamaModelsCacheForTests() {
  cached = null;
}