import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPENROUTER_BASE_URL } from "../index.js";
import {
  listClaudeOpenRouterModels,
  refreshClaudeOpenRouterModels,
  resetClaudeOpenRouterModelsCacheForTests,
} from "./models.js";

const fetchMock = vi.fn();

beforeEach(() => {
  resetClaudeOpenRouterModelsCacheForTests();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

function okModels(payload: unknown) {
  fetchMock.mockResolvedValue({ ok: true, json: async () => payload });
}

describe("listClaudeOpenRouterModels", () => {
  it("reads the public OpenRouter catalog without credentials", async () => {
    okModels({ data: [{ id: "qwen/qwen3-coder:free", name: "Qwen3 Coder (free)", supported_parameters: ["tools"] }] });

    expect(await listClaudeOpenRouterModels()).toEqual([
      { id: "qwen/qwen3-coder:free", label: "Qwen3 Coder (free)" },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${OPENROUTER_BASE_URL}/v1/models`);
    expect(init.headers).toBeUndefined();
  });

  it("drops models without tool calling, invalid ids and duplicates, and sorts by label", async () => {
    okModels({
      data: [
        { id: "z/model", name: "Zeta", supported_parameters: ["tools"] },
        { id: "a/model", name: "Alpha" },
        { id: "a/model", name: "Alpha again" },
        { id: "no-tools/model", name: "No tools", supported_parameters: ["temperature"] },
        { id: "noslash" },
        { id: 42 },
        null,
      ],
    });

    expect(await listClaudeOpenRouterModels()).toEqual([
      { id: "a/model", label: "Alpha" },
      { id: "z/model", label: "Zeta" },
    ]);
  });

  it("caches a successful fetch and bypasses the cache on refresh", async () => {
    okModels({ data: [{ id: "a/model" }] });
    await listClaudeOpenRouterModels();
    await listClaudeOpenRouterModels();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await refreshClaudeOpenRouterModels();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns an empty list and retries next time when the catalog fails", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false });
    expect(await listClaudeOpenRouterModels()).toEqual([]);
    okModels({ data: [{ id: "a/model" }] });
    expect(await listClaudeOpenRouterModels()).toEqual([{ id: "a/model", label: "a/model" }]);
  });
});
