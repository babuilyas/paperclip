import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OLLAMA_BASE_URL } from "../index.js";
import {
  listClaudeOllamaModels,
  refreshClaudeOllamaModels,
  resetClaudeOllamaModelsCacheForTests,
} from "./models.js";

const fetchMock = vi.fn();

beforeEach(() => {
  resetClaudeOllamaModelsCacheForTests();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

function okModels(payload: unknown) {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => payload,
  });
}

describe("listClaudeOllamaModels", () => {
  it("probes the local Ollama server's OpenAI-compatible model list without auth headers", async () => {
    okModels({ data: [{ id: "qwen3-coder:latest", display_name: "Qwen3 Coder" }] });

    const models = await listClaudeOllamaModels();

    expect(models).toEqual([{ id: "qwen3-coder:latest", label: "Qwen3 Coder" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${OLLAMA_BASE_URL}/v1/models`);
    // No auth headers: a local Ollama server needs none, and the adapter owns
    // the endpoint identity anyway.
    expect(init.headers).toBeUndefined();
  });

  it("falls back to the tag when Ollama reports no display name", async () => {
    okModels({ data: [{ id: "llama3.2:latest" }] });

    const models = await listClaudeOllamaModels();

    expect(models).toEqual([{ id: "llama3.2:latest", label: "llama3.2:latest" }]);
  });

  it("skips entries without a usable id and dedupes repeated tags", async () => {
    okModels({
      data: [
        { id: "qwen3-coder:latest" },
        { id: "qwen3-coder:latest", display_name: "duplicate" },
        { id: "   " },
        { display_name: "no id" },
        null,
        "not-an-object",
        { id: "llama3.2:latest" },
      ],
    });

    const models = await listClaudeOllamaModels();

    expect(models).toEqual([
      { id: "qwen3-coder:latest", label: "qwen3-coder:latest" },
      { id: "llama3.2:latest", label: "llama3.2:latest" },
    ]);
  });

  it("returns an empty list when the server is unreachable, without throwing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:11434"));

    await expect(listClaudeOllamaModels()).resolves.toEqual([]);
    warnSpy.mockRestore();
  });

  it("returns an empty list when the server answers with a non-OK status", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });

    await expect(listClaudeOllamaModels()).resolves.toEqual([]);
  });

  it("caches the model list within the TTL window", async () => {
    okModels({ data: [{ id: "qwen3-coder:latest" }] });

    await listClaudeOllamaModels();
    await listClaudeOllamaModels();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("bypasses the cache on refresh", async () => {
    okModels({ data: [{ id: "qwen3-coder:latest" }] });

    await listClaudeOllamaModels();
    okModels({ data: [{ id: "qwen3-coder:latest" }, { id: "llama3.2:latest" }] });
    const refreshed = await refreshClaudeOllamaModels();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshed).toEqual([
      { id: "qwen3-coder:latest", label: "qwen3-coder:latest" },
      { id: "llama3.2:latest", label: "llama3.2:latest" },
    ]);
  });

  it("clears the cache through the test reset hook", async () => {
    okModels({ data: [{ id: "qwen3-coder:latest" }] });

    await listClaudeOllamaModels();
    resetClaudeOllamaModelsCacheForTests();
    await listClaudeOllamaModels();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});