import type { AdapterModel } from "@paperclipai/adapter-utils";
import { OPENROUTER_BASE_URL } from "../index.js";

const OPENROUTER_MODELS_ENDPOINT = "/v1/models";
const OPENROUTER_MODELS_TIMEOUT_MS = 10_000;
const OPENROUTER_MODELS_CACHE_TTL_MS = 60_000;

let cached: { expiresAt: number; models: AdapterModel[] } | null = null;

function supportsTools(record: { supported_parameters?: unknown }): boolean {
  // Claude Code cannot work without tool calling. Keep entries that do not
  // publish their parameters; the operator can still type any model ID.
  if (!Array.isArray(record.supported_parameters)) return true;
  return record.supported_parameters.includes("tools");
}

async function fetchOpenRouterModels(): Promise<AdapterModel[]> {
  try {
    // The public catalog needs no credentials, so no key is sent.
    const response = await fetch(`${OPENROUTER_BASE_URL}${OPENROUTER_MODELS_ENDPOINT}`, {
      signal: AbortSignal.timeout(OPENROUTER_MODELS_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as { data?: unknown };
    const data = Array.isArray(payload.data) ? payload.data : [];
    const seen = new Set<string>();
    const models: AdapterModel[] = [];
    for (const item of data) {
      if (typeof item !== "object" || item === null) continue;
      const record = item as { id?: unknown; name?: unknown; supported_parameters?: unknown };
      const id = typeof record.id === "string" ? record.id.trim() : "";
      if (!id.includes("/") || seen.has(id) || !supportsTools(record)) continue;
      seen.add(id);
      const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : id;
      models.push({ id, label: name });
    }
    return models.sort((a, b) => a.label.localeCompare(b.label));
  } catch (error) {
    console.warn("[paperclip] OpenRouter model discovery failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

async function loadClaudeOpenRouterModels(options?: { forceRefresh?: boolean }): Promise<AdapterModel[]> {
  const now = Date.now();
  if (options?.forceRefresh !== true && cached && cached.expiresAt > now) return cached.models;
  const fetched = await fetchOpenRouterModels();
  // Do not cache a failed or empty fetch, so the next request retries.
  if (fetched.length > 0) cached = { expiresAt: now + OPENROUTER_MODELS_CACHE_TTL_MS, models: fetched };
  return fetched;
}

/** Return OpenRouter's tool-capable model catalog. The static fallback is empty. */
export async function listClaudeOpenRouterModels(): Promise<AdapterModel[]> {
  return loadClaudeOpenRouterModels();
}

export async function refreshClaudeOpenRouterModels(): Promise<AdapterModel[]> {
  return loadClaudeOpenRouterModels({ forceRefresh: true });
}

export function resetClaudeOpenRouterModelsCacheForTests() {
  cached = null;
}
