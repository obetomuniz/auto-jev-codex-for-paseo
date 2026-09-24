import assert from "node:assert/strict";
import { test } from "node:test";
import { defaults, settingsSchema, MAX_PERSONAS } from "../shared/settings";
import { restoreDefaultPersonas, selectPersona } from "../shared/personas";
import { parseStoredSettings } from "../server/settings-store";
import { parseQuestions, questionAnswers, MAX_QUESTIONS } from "../server/questions";
import { nativePolicy, type ExecutionPolicy } from "../server/provider-policy";
import { appendHandoff, handoffPrompt, readHandoff, HANDOFF_MESSAGES, HANDOFF_TEXT_LIMIT } from "../server/handoff";
import type { ContextEntry } from "../server/route-context";

test("old model and effort overrides migrate once to the five personas", () => {
  const settings = parseStoredSettings({ autoCodexModelLead: "future-model", autoCodexEffortLead: "future-effort" });
  const lead = selectPersona(settings, "tech-lead");
  assert.equal(lead.model, "future-model");
  assert.equal(lead.effort, "future-effort");
  assert.equal(lead.provider, "codex");
  lead.model = "newer-model";
  assert.equal(selectPersona(parseStoredSettings(settings), "tech-lead").model, "newer-model");
});

test("default roles and manual selection keep stable IDs", () => {
  const custom = { ...defaults.personas[0], id: "editor", name: "Editor", provider: "opencode", model: "vendor/new-model", effort: "deep" };
  const settings = settingsSchema.parse({ ...defaults, personas: [...defaults.personas, custom] });
  for (const persona of settings.personas) assert.equal(selectPersona(settings, persona.id).id, persona.id);
  assert.equal(selectPersona(settings, custom.id).provider, "opencode");
  settings.personas.find((persona) => persona.id === "tech-lead")!.enabled = false;
  assert.throws(() => selectPersona(settings, "tech-lead"), /disabled/);
  assert.equal(selectPersona(settings, "editor").id, "editor");
});

test("persona validation rejects recursion, duplicate IDs, and unbounded input", () => {
  for (const change of [
    { id: "auto-mode-for-paseo" }, { provider: "auto-mode-for-paseo" }, { provider: "vendor/model" },
    { instructions: "x".repeat(8_001) }, { name: " " }, { model: " " },
  ]) assert.throws(() => settingsSchema.parse({ ...defaults, personas: [...defaults.personas, { ...defaults.personas[0], ...change }] }));
  assert.throws(() => settingsSchema.parse({ personas: Array.from({ length: MAX_PERSONAS + 1 }, (_, i) => ({ ...defaults.personas[0], id: `custom-${i}` })) }));
  assert.equal(settingsSchema.parse({ personas: defaults.personas.map((persona) => ({ ...persona, effort: "" })) }).personas[0].effort, "");
});

test("removed default roles stay absent and require an explicit matched persona ID", () => {
  const settings = settingsSchema.parse({ personas: [{ ...defaults.personas[0], id: "editor", name: "Editor" }] });
  for (const { id } of defaults.personas) {
    assert.throws(() => selectPersona(settings, id), /missing.*restore/);
  }
  assert.throws(() => selectPersona(settings, "tech-lead"), /missing/);
  assert.equal(selectPersona(settings, "editor").id, "editor");
  assert.deepEqual(parseStoredSettings(settings).personas, settings.personas);
  assert.deepEqual(parseStoredSettings({ personas: [] }).personas, []);
  // The old internal manual-only flag is obsolete. Preserve the user's definition.
  const legacy = { ...settings.personas[0], automatic: false };
  assert.deepEqual(parseStoredSettings({ personas: [legacy] }).personas, settings.personas);
});

test("restoring defaults adds only missing personas and respects the limit", () => {
  const edited = { ...defaults.personas[0], name: "My lead", model: "my-model", enabled: false };
  const custom = { ...edited, id: "editor" };
  const restored = restoreDefaultPersonas([edited, custom]);
  assert.deepEqual(restored.slice(0, 2), [edited, custom]);
  assert.deepEqual(restored.slice(2), defaults.personas.slice(1));
  assert.deepEqual(restoreDefaultPersonas(restored), restored);
  const all = restoreDefaultPersonas([]);
  assert.deepEqual(all, defaults.personas);
  all[0].name = "Changed after restoring";
  assert.notEqual(defaults.personas[0].name, all[0].name);
  const full = Array.from({ length: MAX_PERSONAS }, (_, i) => ({ ...custom, id: `custom-${i}` }));
  assert.throws(() => restoreDefaultPersonas(full), /limit is 32/);
});

test("scope migration upgrades only untouched presets and preserves user definitions and providers", () => {
  const personas = [
    { ...defaults.personas[4], description: "Bounded explanations and routine implementation.", provider: "claude", model: "my-model" },
    { ...defaults.personas[2], description: "My specialized review scope." },
    { ...defaults.personas[0], id: "custom", description: "Complex implementation and investigation." },
    { ...defaults.personas[0], id: "constructor", description: "A custom scope." },
  ];
  const settings = parseStoredSettings({ personas, thresholdStaff: 0.9, thresholdCheap: 0.8 });
  assert.equal(settings.personas[0].description, defaults.personas[4].description);
  assert.equal(settings.personas[0].provider, "claude");
  assert.equal(settings.personas[0].model, "my-model");
  assert.deepEqual(settings.personas.slice(1), personas.slice(1));
  assert.equal("thresholdPersona" in parseStoredSettings({ ...settings, thresholdPersona: 0.9 }), false);
  assert.equal("thresholdStaff" in settings, false);
  settings.personas[0].description = "Bounded explanations and routine implementation.";
  assert.deepEqual(parseStoredSettings(settings).personas, settings.personas);
});

test("Paseo question forms preserve all answers by header, free text, and skips", () => {
  const questions = parseQuestions({ questions: [
    { id: "one", header: "Choice", question: "Which?", options: [{ label: "A" }, { label: "B" }] },
    { id: "two", header: "Comment", question: "Anything else?" },
    { id: "three", header: "Skip", question: "Optional?" },
  ] });
  assert.ok(questions.every((question) => question.allowOther));
  assert.deepEqual(questionAnswers(questions, { behavior: "allow", updatedInput: { answers: { Choice: "B", Comment: "Custom response", Skip: "" } } }), {
    answers: { one: { answers: ["B"] }, two: { answers: ["Custom response"] }, three: { answers: [] } },
  });
  assert.deepEqual(questionAnswers(questions, { behavior: "deny" }).answers.one.answers, []);
  assert.throws(() => questionAnswers(questions, { behavior: "allow" }));
  assert.throws(() => questionAnswers(questions, { behavior: "allow", updatedInput: { answers: { Choice: 4 } } }));
});

test("question groups validate first and disambiguate duplicated titles", () => {
  const group = [{ id: "one", header: "Choice", question: "First?" }, { id: "two", header: "Choice", question: "Second?" }];
  const questions = parseQuestions({ questions: group });
  assert.notEqual(questions[0].header, questions[1].header);
  assert.deepEqual(questionAnswers(questions, { behavior: "allow", updatedInput: { answers: { [questions[0].header]: "First", [questions[1].header]: "Second" } } }).answers.two.answers, ["Second"]);
  assert.throws(() => parseQuestions({ questions: [group[0], group[0]] }));
  assert.throws(() => parseQuestions({ questions: [group[0], {}] }));
  assert.throws(() => parseQuestions({ questions: Array.from({ length: MAX_QUESTIONS + 1 }, (_, i) => ({ ...group[0], id: String(i) })) }));
});

const policy: ExecutionPolicy = { provider: "claude", intent: "implement", plan: false, fullAccess: false, fast: false, cwd: process.cwd() };

const claudeModes = ["plan", "default", "acceptEdits", "auto", "bypassPermissions"].map((id) => ({ id, label: id }));

test("native policy keeps review intent separate from Plan and never enables bypass automatically", () => {
  assert.equal(nativePolicy(policy, claudeModes).modeId, "auto");
  for (const intent of ["discuss", "review"] as const) {
    const result = nativePolicy({ ...policy, intent }, claudeModes);
    assert.equal(result.modeId, "auto");
    assert.equal(result.planning, false);
    assert.equal(result.analysisOnly, true);
    assert.equal(nativePolicy({ ...policy, intent, plan: true }, claudeModes).modeId, "plan");
  }
  assert.equal(nativePolicy({ ...policy, fullAccess: true }, claudeModes).modeId, "bypassPermissions");
  assert.equal(nativePolicy({ ...policy, fullAccess: true, plan: true }, claudeModes).modeId, "plan");
  assert.equal(nativePolicy(policy, claudeModes, "acceptEdits").modeId, "acceptEdits");
  for (const saved of ["missing", "bypassPermissions", "plan"]) {
    const mapped = nativePolicy(policy, claudeModes, saved);
    assert.equal(mapped.modeId, "auto");
    assert.ok(mapped.notices.length);
  }
});

test("providers without optional modes use native defaults and keep Full access explicit", () => {
  const grok = nativePolicy({ ...policy, provider: "grok", fast: true }, []);
  assert.equal(grok.modeId, undefined);
  assert.deepEqual(grok.options, {});
  const planning = nativePolicy({ ...policy, plan: true, fullAccess: true }, []);
  assert.equal(planning.planning, true);
  assert.match(planning.notices.join(" "), /no dedicated planning mode/);
  const opencode = { ...policy, provider: "opencode", fullAccess: true };
  assert.equal(nativePolicy(opencode, []).options.permission, "allow");
  assert.deepEqual(nativePolicy({ ...opencode, plan: true }, claudeModes).options, {});
  assert.equal(nativePolicy(policy, [{ id: "default", label: "Ask" }]).modeId, "default");
});

test("execution handoffs have explicit limits and exclude tools and reasoning", () => {
  let context: ContextEntry[] = [];
  for (let i = 0; i < HANDOFF_MESSAGES + 4; i++) context = appendHandoff(context, { id: String(i), role: "user", text: "x".repeat(HANDOFF_TEXT_LIMIT + 1) + "END" });
  assert.equal(context.length, HANDOFF_MESSAGES);
  assert.ok(context.every((entry) => entry.text.length <= HANDOFF_TEXT_LIMIT && entry.text.endsWith("END")));
  assert.equal(context[0].id, "4");
  assert.deepEqual(readHandoff([{ id: "secret", role: "reasoning", text: "private" }, { id: "tool", role: "tool", text: "output" }, null]), []);
  assert.equal(handoffPrompt([], "Current"), "Current");
  assert.ok(handoffPrompt(context, "Current").endsWith("Current"));
});
