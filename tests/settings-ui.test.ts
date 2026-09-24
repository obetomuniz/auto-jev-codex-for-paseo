import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import ts from "typescript";
import * as settings from "../shared/settings";
import * as catalog from "../shared/provider-catalog";
import * as personas from "../shared/personas";
import * as providerModes from "../shared/provider-modes";
import * as taskDepth from "../shared/task-depth";
import * as autosave from "../client/settings-autosave";
import * as taskTypes from "../shared/task-types";
import * as detection from "../client/task-type-detection";

// Render the actual component with host UI primitives represented as elements.
// This checks conditional fields without a running native Paseo client.
function render(classifier: "jev" | "laya", initialPersonas = settings.defaults.personas, providerCatalog?: unknown, loading = false,
  detect: (description: string) => Promise<taskTypes.TaskType[]> = async () => ["other"]) {
  const source = readFileSync("client/settings-screen.tsx", "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText;
  const element = (type: unknown, props: unknown) => ({ type, props });
  const exports: Record<string, any> = {};
  const states: any[] = [];
  let stateIndex = 0;
  const refs: Array<{ current: any }> = [];
  let refIndex = 0;
  let effectIndex = 0;
  let rerender = false;
  const effectDependencies: unknown[][] = [];
  const cleanups: Array<(() => void) | undefined> = [];
  let effects: Array<() => void> = [];
  const saved = { ...settings.toPublic(settings.defaults), classifier, personas: initialPersonas };
  const loadedQuery = { status: loading ? "pending" : "success", isPending: loading, data: loading ? undefined : saved };
  const catalogQuery = { status: providerCatalog ? "success" : "pending", isPending: !providerCatalog, isFetching: !providerCatalog, data: providerCatalog };
  const submissions: settings.ProviderSettings[] = [];
  const detections: string[] = [];
  let savedKey = "";
  let writeGate: Promise<void> | undefined;
  let writeError = false;
  runInNewContext(code, { exports, require(name: string) {
    if (name === "react/jsx-runtime") return { jsx: element, jsxs: element };
    if (name === "react") return { useEffect(effect: () => void | (() => void), dependencies: unknown[]) {
      const index = effectIndex++;
      const previous = effectDependencies[index];
      if (!previous || dependencies.some((value, i) => value !== previous[i])) effects.push(() => {
        cleanups[index]?.();
        cleanups[index] = effect() || undefined;
      });
      effectDependencies[index] = dependencies;
    }, useRef(initial: any) {
      const index = refIndex++;
      return refs[index] ??= { current: initial };
    }, useState(initial: any) {
      const index = stateIndex++;
      if (!(index in states)) states[index] = initial;
      return [states[index], (update: any) => { states[index] = typeof update === "function" ? update(states[index]) : update; rerender = true; }];
    } };
    if (name === "@getpaseo/plugin/client") return { useRpc: (rpc: unknown) => async (values: settings.ProviderSettings) => {
      if (rpc === taskTypes.detectTaskTypesRpc) {
        const { description } = values as unknown as { description: string };
        detections.push(description);
        return { taskTypes: await detect(description) };
      }
      if (rpc === settings.saveSettingsRpc) {
        submissions.push(values);
        await writeGate;
        if (writeError) throw new Error("offline");
        savedKey = values.apiKey || savedKey;
        return settings.toPublic({ ...values, apiKey: savedKey });
      }
    } };
    if (name === "@getpaseo/plugin/client/react-native") return { Icon: "icon" };
    if (name === "@getpaseo/plugin/client/ui") return { SettingsSection: "section", SettingsCard: "card", SettingsInput: "input", SettingsSelect: "select", SettingsAction: "action", SettingsRow: "row" };
    if (name === "@tanstack/react-query") return {
      useQuery: ({ queryKey }: { queryKey: string[] }) => queryKey[1] === "providers" ? catalogQuery : loadedQuery,
      useQueryClient: () => ({ setQueryData(_key: unknown, values: settings.PublicSettings) { loadedQuery.data = values; } }),
    };
    if (name === "react-native") return { Text: "text", TextInput: "native-input", View: "view", Pressable: "pressable", ActivityIndicator: "spinner" };
    if (name === "../shared/settings") return settings;
    if (name === "../shared/provider-catalog") return catalog;
    if (name === "../shared/personas") return personas;
    if (name === "../shared/provider-modes") return providerModes;
    if (name === "../shared/task-depth") return taskDepth;
    if (name === "./settings-autosave") return autosave;
    if (name === "../shared/task-types") return taskTypes;
    if (name === "./task-type-detection") return detection;
    throw new Error("Unexpected import: " + name);
  } });
  function elements() {
    const nodes: any[] = [];
    function visit(node: any): void {
      if (!node) return;
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (node.props) nodes.push(node);
      if (typeof node.type === "function" && ["PersonaScope", "PersonaTaskTypes"].includes(node.type.name)) visit(node.type(node.props));
      visit(node.props?.trailing);
      visit(node.props?.children);
    }
    do {
      rerender = false;
      stateIndex = 0;
      refIndex = 0;
      effectIndex = 0;
      effects = [];
      nodes.length = 0;
      visit(exports.SettingsScreen({ theme: { colors: { statusDanger: "red", border: "gray", surface1: "black", foregroundMuted: "gray" } } }));
      effects.forEach((effect) => effect());
    } while (rerender);
    return nodes;
  }
  return {
    elements,
    labels: () => elements().flatMap((node) => node.props.label ? [node.props.label] : []),
    draft: () => states[0],
    submissions,
    detections,
    async settled() { elements(); await refs[0].current?.flush(); await Promise.resolve(); elements(); },
    unmount() { cleanups.forEach((cleanup) => cleanup?.()); },
    gate(promise: Promise<void> | undefined) { writeGate = promise; },
    fail(value: boolean) { writeError = value; },
    loadedQuery,
    catalogQuery,
    resolveSettings() { Object.assign(loadedQuery, { status: "success", isPending: false, data: saved }); },
    resolveCatalog(data: unknown) { Object.assign(catalogQuery, { status: "success", isPending: false, isFetching: false, data }); },
  };
}

test("cold settings loading never shows default personas and cached settings render immediately", () => {
  const custom = { ...settings.defaults.personas[0], id: "editor", name: "Editor" };
  const ui = render("laya", [custom], undefined, true);
  assert.ok(ui.elements().some((node) => node.type === "spinner" && node.props.accessibilityLabel === "Loading settings"));
  assert.equal(ui.elements().filter((node) => node.props.label === "Name").length, 0);
  assert.ok(!ui.labels().includes("API key"));
  ui.resolveSettings();
  assert.equal(ui.elements().filter((node) => node.props.label === "Name").length, 1);
  assert.equal(ui.elements().find((node) => node.props.label === "Name").props.initialValue, "Editor");
  assert.ok(ui.labels().includes("Python executable"));
  const cached = render("laya", [custom]);
  assert.ok(!cached.elements().some((node) => node.props.accessibilityLabel === "Loading settings"));
  assert.equal(cached.elements().find((node) => node.props.label === "Name").props.initialValue, "Editor");
});

test("default and custom scopes are fully visible and editable with the same autosave behavior", async () => {
  const custom = { ...settings.defaults.personas[0], id: "editor", description: "Edit technical prose." };
  const ui = render("jev", [settings.defaults.personas[0], custom]);
  const scopes = ui.elements().filter((node) => node.type === "native-input" && node.props.accessibilityLabel === "Scope");
  assert.equal(scopes.length, 2);
  assert.equal(scopes[0].props.value, settings.defaults.personas[0].description);
  assert.ok(scopes.every((node) => node.props.multiline && node.props.maxLength === 240));
  scopes[0].props.onChangeText("Review existing code for correctness.");
  scopes[1].props.onChangeText("Translate technical prose into Portuguese.");
  const depths = ui.elements().filter((node) => node.props.label === "Task depth");
  assert.equal(depths.length, 2);
  depths[0].props.onValueChange("high");
  depths[1].props.onValueChange("low");
  await ui.settled();
  assert.equal(ui.submissions.at(-1)!.personas[0].description, "Review existing code for correctness.");
  assert.equal(ui.submissions.at(-1)!.personas[1].description, "Translate technical prose into Portuguese.");
  assert.equal(ui.submissions.at(-1)!.personas[0].taskDepth, "high");
  assert.equal(ui.submissions.at(-1)!.personas[1].taskDepth, "low");
  ui.unmount();
});

test("catalog loading stays inside select fields and refresh preserves field values and edits", () => {
  const persona = settings.defaults.personas[0];
  const ui = render("jev", [persona]);
  const labels = ["Provider", "Available models", "Reasoning effort"];
  const fields = () => labels.map((label) => ui.elements().find((node) => node.props.label === label));
  for (const field of fields()) {
    assert.equal(field.type, "select");
    assert.equal(field.props.disabled, true);
    assert.equal(field.props.hint, undefined);
    assert.equal(field.props.options[0].label, "Loading...");
  }
  const values = fields().map((field) => field.props.value);
  ui.elements().find((node) => node.props.label === "Name").props.onChangeText("My lead");
  ui.resolveCatalog([{ id: persona.provider, label: "Provider", models: [{ id: persona.model, label: "Model", efforts: [{ id: persona.effort, label: "Effort" }] }] }]);
  assert.deepEqual(fields().map((field) => field.props.value), values);
  assert.ok(fields().every((field) => field.type === "select" && !field.props.disabled && field.props.hint === undefined));
  ui.catalogQuery.isFetching = true;
  assert.ok(fields().every((field) => field.type === "select" && !field.props.disabled && !field.props.options.some((option: { label: string }) => option.label === "Loading...")));
  const refresh = ui.elements().find((node) => node.props.accessibilityLabel === "Refresh available providers and models");
  assert.equal(refresh.props.label, "Refresh");
  assert.equal(refresh.props.busy, true);
  ui.loadedQuery.data = { ...ui.loadedQuery.data! };
  assert.equal(ui.elements().find((node) => node.props.label === "Name").props.initialValue, "My lead");
});

test("settings ask for a TypeSafe key only with Jev selected", () => {
  const jev = render("jev").labels();
  assert.ok(jev.includes("API key"));
  assert.ok(!jev.includes("Python executable"));
  const laya = render("laya").labels();
  assert.ok(!laya.includes("API key"));
  assert.ok(laya.includes("Available models"));
  assert.ok(!laya.includes("Model"));
  assert.ok(laya.includes("Python executable"));
  assert.ok(laya.includes("Laya model"));
  assert.ok(laya.includes("Device"));
});

test("default and custom personas use generic fields and can be removed and restored", () => {
  const custom = { ...settings.defaults.personas[0], id: "editor", name: "Editor" };
  const ui = render("jev", [...settings.defaults.personas, custom]);
  assert.equal(ui.labels().filter((label) => label === "Name").length, 6);
  assert.ok(!ui.labels().some((label) => /Tech Lead|Staff|Critic|Reporter|Writer|Editor/.test(label)));
  const remove = ui.elements().filter((node) => node.props.accessibilityLabel === "Remove persona");
  assert.equal(remove.length, 6);
  assert.equal(ui.elements().find((node) => node.props.accessibilityLabel === "Restore missing default personas").props.disabled, true);
  remove[0].props.onPress();
  assert.ok(!ui.draft().personas.some((persona: settings.Persona) => persona.id === "tech-lead"));
  assert.ok(ui.draft().personas.some((persona: settings.Persona) => persona.id === "editor"));
  const restore = ui.elements().find((node) => node.props.accessibilityLabel === "Restore missing default personas");
  assert.equal(restore.props.disabled, false);
  restore.props.onPress();
  assert.equal(ui.draft().personas.length, 6);
  assert.ok(ui.draft().personas.some((persona: settings.Persona) => persona.id === "tech-lead"));
  ui.elements().filter((node) => node.props.accessibilityLabel === "Remove persona")[4].props.onPress();
  assert.ok(!ui.draft().personas.some((persona: settings.Persona) => persona.id === "editor"));
});

test("model selection offers only available models while retaining a missing saved model for correction", () => {
  const initial = [{ ...settings.defaults.personas[0], model: "retired-model", effort: "high" }];
  const providers = [{ id: "codex", label: "Codex", models: [{ id: "new-model", label: "New Model", efforts: [] }] }];
  const ui = render("laya", initial, providers);
  const model = ui.elements().find((node) => node.props.label === "Available models");
  assert.equal(model.props.value, "");
  assert.equal(model.props.disabled, false);
  assert.match(model.props.hint, /saved model is unavailable/);
  assert.ok(!model.props.options.some((option: { label: string }) => option.label === "retired-model"));
  assert.ok(model.props.options.some((option: { label: string; value: string }) => option.label === "New Model" && option.value === "new-model"));
  assert.equal(ui.draft().personas[0].model, "retired-model");
  model.props.onValueChange("new-model");
  assert.equal(ui.draft().personas[0].model, "new-model");
  assert.equal(ui.draft().personas[0].effort, "");
  for (const unavailable of [undefined, [{ ...providers[0], models: [] }]]) {
    const unavailableUi = render("laya", initial, unavailable);
    const field = unavailableUi.elements().find((node) => node.props.label === "Available models");
    assert.equal(field.props.disabled, true);
    assert.equal(unavailableUi.draft().personas[0].model, "retired-model");
  }
});

test("persona configuration exposes only supported efforts and work modes and resets dependent choices", () => {
  const initial = [{ ...settings.defaults.personas[0], provider: "claude", model: "reasoner", effort: "deep", workMode: "auto" }];
  const providers = [
    { id: "claude", label: "Claude", modes: ["auto", "default", "plan", "bypassPermissions"].map((id) => ({ id, label: id })),
      models: [{ id: "reasoner", label: "Reasoner", efforts: [{ id: "deep", label: "Deep" }] }, { id: "simple", label: "Simple", efforts: [] }] },
    { id: "grok", label: "Grok", modes: [], models: [{ id: "grok-model", label: "Grok model", efforts: [] }] },
  ];
  const ui = render("laya", initial, providers);
  const field = (label: string) => ui.elements().find((node) => node.props.label === label).props;
  const values = (label: string) => Array.from(field(label).options, (option: any) => option.value);
  assert.deepEqual(values("Reasoning effort"), ["", "deep"]);
  assert.deepEqual(values("Work mode"), ["", "auto", "default"]);
  field("Available models").onValueChange("simple");
  assert.equal(ui.draft().personas[0].effort, "");
  assert.ok(!ui.labels().includes("Reasoning effort"));
  field("Available models").onValueChange("reasoner");
  assert.deepEqual(values("Reasoning effort"), ["", "deep"]);
  assert.equal(field("Reasoning effort").disabled, false);
  field("Provider").onValueChange("grok");
  for (const key of ["model", "effort", "workMode"]) assert.equal(ui.draft().personas[0][key], "");
  assert.deepEqual(values("Available models"), ["", "grok-model"]);
  assert.ok(!ui.labels().includes("Work mode"));
  assert.ok(!ui.labels().includes("Reasoning effort"));
  field("Available models").onValueChange("grok-model");
  assert.ok(!ui.labels().includes("Reasoning effort"));
  ui.unmount();
});

test("Codex exposes its supported work modes and hides the selector when no work mode exists", async () => {
  const persona = settings.defaults.personas[0];
  const provider = { id: "codex", label: "Codex", modes: [
    { id: "auto", label: "Default Permissions" }, { id: "auto-review", label: "Auto-review" }, { id: "full-access", label: "Full Access" },
  ], models: [{ id: persona.model, label: "Model", efforts: [{ id: persona.effort, label: "High" }] }] };
  const ui = render("laya", [persona], [provider]);
  const field = ui.elements().find((node) => node.props.label === "Work mode");
  assert.ok(field);
  assert.equal(field.props.disabled, false);
  assert.deepEqual(Array.from(field.props.options, (option: any) => option.value), ["", "auto", "auto-review"]);
  field.props.onValueChange("auto");
  await ui.settled();
  assert.equal(ui.submissions.at(-1)!.personas[0].workMode, "auto");
  ui.resolveCatalog([{ ...provider, modes: [{ id: "full-access", label: "Full Access" }] }]);
  assert.ok(!ui.labels().includes("Work mode"));
  ui.unmount();
});

test("incomplete personas show field errors and save automatically once complete", async () => {
  const providers = [{ id: "codex", label: "Codex", models: [{ id: "new-model", label: "New Model", efforts: [] }] }];
  const ui = render("jev", settings.defaults.personas, providers);
  ui.elements().find((node) => node.props.label === "Create persona").props.onPress();
  const field = (label: string) => ui.elements().filter((node) => node.props.label === label).at(-1)!;
  field("Name").props.onChangeText("  ");
  await ui.settled();
  assert.equal(ui.submissions.length, 0);
  assert.equal(field("Name").props.error, "Enter a name.");
  assert.equal(field("Available models").props.error, "Choose a model.");
  assert.ok(!ui.elements().some((node) => node.props.title === "Save"));
  assert.ok(ui.elements().filter((node) => node.props.label === "Available models").slice(0, -1).every((node) => !node.props.error));
  field("Name").props.onChangeText("  Editor  ");
  assert.equal(field("Name").props.error, undefined);
  assert.equal(field("Available models").props.error, "Choose a model.");
  field("Available models").props.onValueChange("new-model");
  assert.equal(field("Available models").props.error, undefined);
  await ui.settled();
  assert.equal(ui.submissions.length, 1);
  assert.equal(ui.submissions[0].personas.at(-1)!.name, "Editor");
  assert.equal(ui.submissions[0].personas.at(-1)!.model, "new-model");
  assert.equal(ui.submissions[0].personas.at(-1)!.effort, "");
  assert.equal(ui.submissions[0].personas.at(-1)!.instructions, "");
  assert.equal(ui.loadedQuery.data!.personas.at(-1)!.model, "new-model");
  assert.equal("apiKey" in ui.loadedQuery.data!, false);
  assert.ok(!ui.elements().some((node) => node.props.error));
});

test("field errors follow the current personas after removals and also identify invalid classifier fields", async () => {
  const custom = { ...settings.defaults.personas[0], id: "editor", name: "Editor" };
  const ui = render("laya", [settings.defaults.personas[0], custom, { ...custom, id: "writer-custom", name: "Writer" }]);
  ui.elements().filter((node) => node.props.label === "Provider").slice(1).forEach((node) => node.props.onValueChange("claude"));
  ui.elements().find((node) => node.props.label === "Python executable").props.onChangeText("");
  await ui.settled();
  assert.equal(ui.submissions.length, 0);
  assert.equal(ui.elements().find((node) => node.props.label === "Python executable").props.error, "Enter the Python executable.");
  ui.elements().filter((node) => node.props.accessibilityLabel === "Remove persona")[0].props.onPress();
  const modelFields = () => ui.elements().filter((node) => node.props.label === "Available models");
  assert.equal(modelFields().length, 2);
  assert.ok(modelFields().every((node) => node.props.error === "Choose a model."));
  ui.elements().filter((node) => node.props.accessibilityLabel === "Remove persona")[0].props.onPress();
  assert.equal(modelFields().length, 1);
  assert.equal(modelFields()[0].props.error, "Choose a model.");
  ui.elements().find((node) => node.props.accessibilityLabel === "Remove persona").props.onPress();
  ui.elements().find((node) => node.props.label === "Python executable").props.onChangeText(settings.defaults.layaPython);
  await ui.settled();
  assert.equal(ui.submissions.length, 1);
  assert.deepEqual(ui.submissions[0].personas, []);
});

test("ordinary edits save without a button and API key edits require their own Save or Cancel", async () => {
  const ui = render("jev");
  const keyField = () => ui.elements().find((node) => node.type === "native-input" && node.props.accessibilityLabel === "API key");
  const keyButton = (label: string) => ui.elements().find((node) => node.props.accessibilityLabel === label);
  keyField().props.onChangeText("test-key-unsaved");
  ui.elements().find((node) => node.props.label === "Model").props.onChangeText("jev-new");
  await ui.settled();
  assert.equal(ui.submissions.length, 1);
  assert.equal(ui.submissions[0].model, "jev-new");
  assert.equal(ui.submissions[0].apiKey, "");
  assert.equal(keyField().props.value, "test-key-unsaved");
  keyButton("Cancel API key change").props.onPress();
  await ui.settled();
  assert.equal(ui.submissions.length, 1);
  assert.equal(keyField().props.value, "");
  assert.equal(keyButton("Save API key"), undefined);
  keyField().props.onChangeText("test-key-explicit");
  keyButton("Save API key").props.onPress();
  await ui.settled();
  assert.equal(ui.submissions[1].apiKey, "test-key-explicit");
  assert.equal(keyField().props.value, "");
  assert.equal(ui.loadedQuery.data!.hasApiKey, true);
  assert.equal("apiKey" in ui.loadedQuery.data!, false);
});

test("a failed key save stays inline and normal saves never submit the pending key", async () => {
  const ui = render("jev");
  const keyField = () => ui.elements().find((node) => node.type === "native-input");
  ui.fail(true);
  keyField().props.onChangeText("test-key-failed");
  ui.elements().find((node) => node.props.accessibilityLabel === "Save API key").props.onPress();
  await ui.settled();
  assert.equal(keyField().props.value, "test-key-failed");
  assert.match(ui.elements().find((node) => node.props.label === "API key").props.error, /Could not save/);
  ui.fail(false);
  ui.elements().find((node) => node.props.label === "Model").props.onChangeText("jev-new");
  await ui.settled();
  assert.equal(ui.submissions.at(-1)!.apiKey, "");
  assert.equal(keyField().props.value, "test-key-failed");
});

test("leaving settings flushes the latest valid edit without submitting an unconfirmed key", async () => {
  const ui = render("jev");
  ui.elements().find((node) => node.type === "native-input").props.onChangeText("test-key-local");
  ui.elements().find((node) => node.props.label === "Model").props.onChangeText("jev-before-leaving");
  ui.unmount();
  await ui.settled();
  assert.equal(ui.submissions.length, 1);
  assert.equal(ui.submissions[0].model, "jev-before-leaving");
  assert.equal(ui.submissions[0].apiKey, "");
});

test("a slow autosave keeps fields editable and never replaces a newer edit", async () => {
  const ui = render("jev");
  let release!: () => void;
  ui.gate(new Promise<void>((resolve) => { release = resolve; }));
  const field = () => ui.elements().find((node) => node.props.label === "Model");
  field().props.onChangeText("first-edit");
  const saving = ui.settled();
  assert.equal(ui.submissions.length, 1);
  assert.equal(field().props.disabled, false);
  field().props.onChangeText("latest-edit");
  release();
  await saving;
  assert.equal(ui.submissions.at(-1)!.model, "latest-edit");
  assert.equal(field().props.initialValue, "latest-edit");
  assert.equal(ui.loadedQuery.data!.model, "latest-edit");
});

test("Used for shows detected tags, detects edited scopes and switches to manual on selection", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  const translator = { ...settings.defaults.personas[0], id: "translator", name: "Translator", description: "Translate prose.", taskTypes: [], taskTypesAuto: true, taskTypesScope: "" };
  const manualOnly = { ...translator, id: "manual-only", description: "" };
  const ui = render("jev", [settings.defaults.personas[2], translator, manualOnly], undefined, false, async () => ["write"]);
  const chips = () => ui.elements().filter((node) => node.props.accessibilityRole === "checkbox");
  const checked = () => chips().filter((node) => node.props.accessibilityState.checked).map((node) => node.props.accessibilityLabel);
  const text = (value: string) => ui.elements().some((node) => node.type === "text" && node.props.children === value);
  assert.equal(chips().length, 12, "Personas without a scope have no task types.");
  assert.deepEqual(checked(), ["Used for Review"]);
  assert.ok(text("Detecting from scope..."));
  t.mock.timers.tick(800);
  await flush();
  assert.deepEqual(ui.detections, ["Translate prose."]);
  assert.deepEqual(checked(), ["Used for Review", "Used for Write"]);
  assert.ok(text("Detected from scope. Select a type to set them manually."));
  chips().filter((node) => node.props.accessibilityLabel === "Used for Review")[1].props.onPress();
  assert.deepEqual(ui.draft().personas[1].taskTypes, ["review", "write"]);
  assert.equal(ui.draft().personas[1].taskTypesAuto, false);
  assert.ok(text("Set manually."));
  ui.elements().find((node) => node.props.accessibilityLabel === "Detect task types from scope").props.onPress();
  assert.equal(ui.draft().personas[1].taskTypesAuto, true);
  t.mock.timers.tick(800);
  await flush();
  assert.deepEqual(ui.detections, ["Translate prose.", "Translate prose."]);
  assert.deepEqual(ui.draft().personas[1].taskTypes, ["write"]);
  await ui.settled();
  const saved = ui.submissions.at(-1)!.personas[1];
  assert.deepEqual([saved.taskTypes, saved.taskTypesAuto, saved.taskTypesScope], [["write"], true, "Translate prose."]);
  ui.unmount();
});

test("detection errors stay inline and do not block other settings", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  const custom = { ...settings.defaults.personas[0], id: "custom", description: "Plan migrations.", taskTypes: [], taskTypesAuto: true, taskTypesScope: "" };
  const ui = render("jev", [custom], undefined, false, async () => { throw new Error("TypeSafe API key rejected."); });
  ui.elements();
  t.mock.timers.tick(800);
  await flush();
  const status = ui.elements().find((node) => node.type === "text" && String(node.props.children).startsWith("Could not detect task types."));
  assert.equal(status.props.children, "Could not detect task types. TypeSafe API key rejected.");
  assert.equal(status.props.style.color, "red");
  assert.ok(ui.elements().some((node) => node.props.accessibilityLabel === "Detect task types from scope"));
  ui.elements().find((node) => node.props.label === "Name").props.onChangeText("Planner");
  await ui.settled();
  assert.equal(ui.submissions.at(-1)!.personas[0].name, "Planner");
  ui.unmount();
});
