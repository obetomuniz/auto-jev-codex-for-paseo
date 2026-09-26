import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { loadSettings, parseStoredSettings, saveSettings } from "../server/settings-store";
import { defaults, settingsSchema, toPublic } from "../shared/settings";
import { assignedTaskTypes } from "../shared/presets";

test("task depth migration seeds templates once without reading model names or reasoning settings", () => {
  const legacy = defaults.presets.map(({ taskDepth: _depth, ...preset }) => ({ ...preset, provider: "claude", effort: "high" }));
  const migrated = parseStoredSettings({ presets: [...legacy, { ...legacy[0], id: "custom" }] });
  assert.deepEqual(migrated.presets.slice(0, 5).map((preset) => preset.taskDepth), defaults.presets.map((preset) => preset.taskDepth));
  assert.equal(migrated.presets[5].taskDepth, "medium");
  assert.ok(migrated.presets.every((preset) => preset.provider === "claude" && preset.effort === "high"));
  migrated.presets[0].taskDepth = "low";
  assert.equal(parseStoredSettings(migrated).presets[0].taskDepth, "low");
});

test("task type migration seeds default scopes only and preserves stored or edited tags", () => {
  const legacy = defaults.presets.map(({ taskTypes: _types, taskTypesAuto: _auto, taskTypesScope: _scope, ...preset }) => preset);
  const edited = { ...legacy[0], id: "custom", description: "Translate prose into Portuguese." };
  const renamed = { ...legacy[2], id: "reviewer", name: "Reviewer" };
  const migrated = parseStoredSettings({ presets: [...legacy, edited, renamed] });
  assert.deepEqual(migrated.presets.slice(0, 5).map(assignedTaskTypes), defaults.presets.map((preset) => preset.taskTypes));
  assert.equal(assignedTaskTypes(migrated.presets[5]), null, "An edited scope stays untagged until detection.");
  assert.deepEqual(assignedTaskTypes(migrated.presets[6]), ["review"], "Seeding follows the scope, not the ID.");
  const manual = { ...defaults.presets[0], taskTypes: ["write" as const], taskTypesAuto: false };
  assert.deepEqual(parseStoredSettings({ presets: [manual] }).presets[0].taskTypes, ["write"]);
});

test("task type settings reject empty manual sets and duplicates", () => {
  const preset = defaults.presets[0];
  const parse = (values: Partial<typeof preset>) => settingsSchema.safeParse({ presets: [{ ...preset, ...values }] });
  const empty = parse({ taskTypes: [], taskTypesAuto: false });
  assert.equal(empty.success, false);
  assert.deepEqual(empty.error!.issues[0].path, ["presets", 0, "taskTypes"]);
  assert.equal(parse({ taskTypes: ["review", "review"] }).success, false);
  assert.equal(parse({ taskTypes: [], taskTypesAuto: true }).success, true);
  assert.equal(parse({ taskTypes: ["unknown" as never] }).success, false);
});

function mockSettingsWrites(t: TestContext, commit: (text: string) => void | Promise<void>) {
  const temporary = new Map<string, string>();
  t.mock.method(fs, "mkdir", async () => undefined);
  t.mock.method(fs, "writeFile", async (path: unknown, content: unknown) => { temporary.set(String(path), String(content)); });
  t.mock.method(fs, "rename", async (from: unknown, to: unknown) => {
    assert.ok(String(to).endsWith("auto-mode-for-paseo.local.json"));
    assert.ok(temporary.has(String(from)));
    await commit(temporary.get(String(from))!);
    temporary.delete(String(from));
  });
  t.mock.method(fs, "rm", async (path: unknown) => { temporary.delete(String(path)); });
}

test("settings writes preserve readable data until replacement and recover from a failed write", async (t) => {
  const initial = { ...defaults, apiKey: "test-key" };
  let stored = JSON.stringify(initial);
  const temporary = new Map<string, string>();
  let writeStarted!: () => void;
  const started = new Promise<void>((resolve) => { writeStarted = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let fail = true;
  t.mock.method(fs, "readFile", async () => stored);
  t.mock.method(fs, "mkdir", async () => undefined);
  t.mock.method(fs, "writeFile", async (path: unknown, content: unknown) => {
    if (String(path).endsWith(".local.json")) stored = "";
    else temporary.set(String(path), "");
    writeStarted();
    await gate;
    if (fail) throw new Error("Disk unavailable");
    if (String(path).endsWith(".local.json")) stored = String(content);
    else temporary.set(String(path), String(content));
  });
  t.mock.method(fs, "rename", async (from: unknown) => { stored = temporary.get(String(from))!; temporary.delete(String(from)); });
  t.mock.method(fs, "rm", async (path: unknown) => { temporary.delete(String(path)); });
  const pending = saveSettings({ ...initial, model: "jev-test-a" });
  const rejected = assert.rejects(pending, /Disk unavailable/);
  await started;
  try { assert.deepEqual(await loadSettings(), initial); }
  finally { release(); await rejected; }
  assert.deepEqual(await loadSettings(), initial);
  assert.equal(temporary.size, 0);
  fail = false;
  await saveSettings({ ...initial, apiKey: "", model: "jev-test-a" });
  assert.equal((await loadSettings()).model, "jev-test-a");
  assert.equal((await loadSettings()).apiKey, "test-key");
});

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
  mockSettingsWrites(t, (text) => { stored = text; });
  const loaded = await loadSettings();
  const saved = await saveSettings({ ...loaded, apiKey: "", model: "jev-test-a" });
  assert.equal("apiKey" in saved, false);
  assert.equal(saved.hasApiKey, true);
  assert.equal("fallbackStaff" in JSON.parse(stored), false);
  assert.deepEqual(await loadSettings(), { ...loaded, model: "jev-test-a" });
});

test("saving deleted default presets preserves deletions, including an empty list", async (t) => {
  let stored = JSON.stringify({ ...defaults, apiKey: "test-key" });
  t.mock.method(fs, "readFile", async () => stored);
  mockSettingsWrites(t, (text) => { stored = text; });
  const remaining = defaults.presets.slice(1).map((preset) => ({ ...preset, model: "configured-model" }));
  const saved = await saveSettings({ ...defaults, presets: remaining });
  assert.deepEqual(saved.presets, remaining);
  assert.deepEqual((await loadSettings()).presets, remaining);
  await saveSettings({ ...defaults, presets: [] });
  assert.deepEqual((await loadSettings()).presets, []);
  assert.equal((await loadSettings()).apiKey, "test-key");
});


test("legacy settings default to Jev and invalid classifiers stop loading", async (t) => {
  assert.equal(parseStoredSettings({}).classifier, "jev");
  assert.equal(parseStoredSettings({ classifier: "laya" }).apiKey, "");
  assert.equal(parseStoredSettings({ layaCache: "C:/local-laya-cache" }).layaCache, "C:/local-laya-cache");
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
  mockSettingsWrites(t, (text) => { current = text; });
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

test("overlapping settings clients preserve a newly saved key and receive their own save results", async (t) => {
  let stored = JSON.stringify({ ...defaults, apiKey: "test-key-old" });
  let commits = 0;
  let started!: () => void;
  const firstCommit = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const read = t.mock.method(fs, "readFile", async () => stored);
  mockSettingsWrites(t, async (text) => {
    if (++commits === 1) { started(); await gate; }
    stored = text;
  });
  const first = saveSettings({ ...defaults, apiKey: "test-key-new", model: "jev-test-a" });
  await firstCommit;
  const second = saveSettings({ ...defaults, apiKey: "", model: "jev-test-b" });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(read.mock.callCount(), 1);
  } finally { release(); }
  const saved = await Promise.all([first, second]);
  assert.deepEqual(saved.map((value) => value.model), ["jev-test-a", "jev-test-b"]);
  assert.equal((await loadSettings()).apiKey, "test-key-new");
  assert.equal((await loadSettings()).model, "jev-test-b");
});
