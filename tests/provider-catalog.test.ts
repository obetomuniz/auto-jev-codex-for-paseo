import assert from "node:assert/strict";
import { test } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { providerCatalog } from "../server/provider-catalog";

test("settings discovery refreshes installed models and excludes the router", async () => {
  let refreshed: unknown;
  const requested: string[] = [];
  const paseo = { providers: {
    listAvailable: async () => ({ providers: [
      { provider: "auto-mode-for-paseo", available: true }, { provider: "auto-jev-codex-for-paseo", available: true },
      { provider: "claude", available: true }, { provider: "custom", available: true }, { provider: "offline", available: false },
    ] }),
    refresh: async (options: unknown) => { refreshed = options; return { acknowledged: true }; },
    waitForReady: async () => ({}),
    listModes: async () => ({ modes: [{ id: "auto", label: "Auto mode" }, { id: "plan", label: "Plan" }] }),
    listModels: async (provider: string) => {
      requested.push(provider);
      if (provider === "custom") throw new Error("Provider unreachable");
      return { models: [{ id: "released-today", label: "New model", thinkingOptions: [{ id: "deep", label: "Deep" }] }, { id: "hidden", isSelectable: false }] };
    },
  } } as unknown as PaseoApi;
  const result = await providerCatalog(paseo);
  assert.deepEqual(refreshed, { providers: ["claude", "custom", "offline"] });
  assert.deepEqual(requested, ["claude", "custom"]);
  assert.deepEqual(result[0].models, [{ id: "released-today", label: "New model", efforts: [{ id: "deep", label: "Deep" }] }]);
  assert.deepEqual(result[0].modes, [{ id: "auto", label: "Auto mode" }, { id: "plan", label: "Plan" }]);
  assert.equal(result[1].error, "Provider unreachable");
  assert.equal(result[2].models.length, 0);
});

test("catalog waits for refresh and discovers a newly connected provider in the same request", async () => {
  let release!: () => void;
  const discovery = new Promise<void>((resolve) => { release = resolve; });
  let ready = false;
  const calls: string[] = [];
  const paseo = { providers: {
    listAvailable: async () => ({ providers: [{ provider: "claude", available: ready }] }),
    refresh: async () => { calls.push("refresh"); return { acknowledged: true }; },
    waitForReady: async () => { calls.push("wait"); await discovery; ready = true; },
    listModes: async () => { throw new Error("Modes not supported"); },
    listModels: async () => { calls.push("models"); return { models: [{ id: "new-model", label: "New model" }] }; },
  } } as unknown as PaseoApi;
  const result = providerCatalog(paseo);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["refresh", "wait"]);
  release();
  assert.deepEqual((await result)[0].models, [{ id: "new-model", label: "New model", efforts: [] }]);
});
