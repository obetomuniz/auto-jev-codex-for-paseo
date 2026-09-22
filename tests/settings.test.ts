import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";
import { loadSettings, parseStoredSettings, saveSettings } from "../server/settings-store";
import { defaults, toPublic } from "../shared/settings";

const blankModels = {
  autoCodexModelStaff: "",
  autoCodexModelReview: " ",
  autoCodexModelCheap: "",
  autoCodexModelLead: "",
};

test("legacy blank models preserve the previous Codex fallback priorities", () => {
  const migrated = parseStoredSettings({
    ...blankModels,
    apiKey: "test-key",
    profileStaff: "old-profile",
    fallbackStaff: "codex/architecture-model",
    fallbackReview: " codex/review-model ",
    autoCodexEffortLead: "high",
  });
  assert.equal(migrated.autoCodexModelStaff, "architecture-model");
  assert.equal(migrated.autoCodexModelLead, "architecture-model");
  assert.equal(migrated.autoCodexModelReview, "review-model");
  assert.equal(migrated.autoCodexModelCheap, "review-model");
  assert.equal(migrated.autoCodexEffortLead, "high");
  assert.equal(migrated.apiKey, "test-key");
  assert.equal("profileStaff" in migrated, false);
  assert.equal("fallbackStaff" in migrated, false);
  assert.deepEqual(parseStoredSettings(migrated), migrated);
});

test("legacy migration ignores non-Codex fallbacks and preserves explicit models", () => {
  const migrated = parseStoredSettings({
    ...blankModels,
    fallbackStaff: "grok/other-model",
    fallbackReview: "codex/",
    fallbackCheap: "codex/unused-cheap-fallback",
    fallbackLead: "codex/unused-lead-fallback",
    autoCodexModelStaff: "custom-model",
  });
  assert.equal(migrated.autoCodexModelStaff, "custom-model");
  assert.equal(migrated.autoCodexModelCheap, defaults.autoCodexModelStaff);
  assert.equal(migrated.autoCodexModelReview, defaults.autoCodexModelStaff);
  assert.equal(migrated.autoCodexModelLead, defaults.autoCodexModelStaff);
  assert.deepEqual(parseStoredSettings({ fallbackStaff: "codex/legacy" }), defaults);
});

test("provider settings retain blank fields and never expose the API key", () => {
  assert.deepEqual(parseStoredSettings(defaults), defaults);
  assert.equal(parseStoredSettings(blankModels).autoCodexModelCheap, "");
  const publicSettings = toPublic({ ...defaults, apiKey: "test-key" });
  assert.equal(publicSettings.hasApiKey, true);
  assert.equal("apiKey" in publicSettings, false);
});

test("saving migrated settings preserves the key and model choices across reloads", async (t) => {
  let stored = JSON.stringify({ ...blankModels, apiKey: "test-key", fallbackStaff: "codex/custom" });
  t.mock.method(fs, "readFile", async () => stored);
  t.mock.method(fs, "mkdir", async () => undefined);
  t.mock.method(fs, "writeFile", async (...[_path, content]: Parameters<typeof fs.writeFile>) => { stored = String(content); });
  const loaded = await loadSettings();
  const saved = await saveSettings({ ...loaded, apiKey: "", thresholdStaff: 0.9 });
  assert.equal("apiKey" in saved, false);
  assert.equal(saved.hasApiKey, true);
  assert.equal("fallbackStaff" in JSON.parse(stored), false);
  assert.deepEqual(await loadSettings(), { ...loaded, thresholdStaff: 0.9 });
});


test("legacy settings default to Jev and invalid classifiers stop loading", async (t) => {
  assert.equal(parseStoredSettings({}).classifier, "jev");
  assert.equal(parseStoredSettings({ classifier: "laya" }).apiKey, "");
  for (const invalid of [{ classifier: "other" }, { layaModel: "other" }, { layaDevice: "other" }, { layaPython: " " }]) {
    assert.throws(() => parseStoredSettings(invalid));
  }
  t.mock.method(fs, "readFile", async () => '{"classifier":"other"}');
  await assert.rejects(loadSettings(), /Could not read/);
});

test("legacy filename migrates on save and switching classifiers retains the secret", async (t) => {
  const legacy = JSON.stringify({ apiKey: "test-key", autoCodexModelStaff: "custom-model" });
  let current: string | undefined;
  t.mock.method(fs, "readFile", async (path: unknown) => {
    if (String(path).endsWith("auto-jev-codex-for-paseo.local.json")) return legacy;
    if (current !== undefined) return current;
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  });
  t.mock.method(fs, "mkdir", async () => undefined);
  t.mock.method(fs, "writeFile", async (path: unknown, content: unknown) => {
    assert.ok(String(path).endsWith("auto-mode-for-paseo.local.json")); current = String(content);
  });
  const loaded = await loadSettings();
  assert.equal(loaded.classifier, "jev");
  assert.equal(loaded.autoCodexModelStaff, "custom-model");
  const saved = await saveSettings({ ...loaded, classifier: "laya", apiKey: "" });
  assert.equal(saved.hasApiKey, true);
  assert.equal("apiKey" in saved, false);
  assert.equal((await loadSettings()).classifier, "laya");
  await saveSettings({ ...await loadSettings(), classifier: "jev", apiKey: "" });
  assert.equal((await loadSettings()).apiKey, "test-key");
});

test("invalid new settings do not silently fall back to the old file", async (t) => {
  const read = t.mock.method(fs, "readFile", async () => "not JSON");
  await assert.rejects(loadSettings(), /Could not read/);
  assert.equal(read.mock.callCount(), 1);
});
