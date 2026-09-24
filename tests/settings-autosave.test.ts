import assert from "node:assert/strict";
import { test } from "node:test";
import { SettingsAutosave, settingsForAutosave, type SaveState } from "../client/settings-autosave";
import { defaults, toPublic, type ProviderSettings } from "../shared/settings";

test("autosave isolates invalid fields and personas while saving valid changes and removals", () => {
  const previous = { ...defaults, apiKey: "" };
  const draft = { ...toPublic(previous), layaPython: "", model: "updated-classifier",
    personas: [{ ...previous.personas[0], provider: "claude", model: "" },
      { ...previous.personas[1], name: "Architect" }, { ...previous.personas[2], id: "custom-new", model: "" }],
  };
  const saved = settingsForAutosave(draft, previous);
  assert.equal(saved.layaPython, previous.layaPython);
  assert.equal(saved.model, "updated-classifier");
  assert.deepEqual(saved.personas[0], previous.personas[0]);
  assert.equal(saved.personas[1].name, "Architect");
  assert.equal(saved.personas.length, 2);
  assert.equal(saved.apiKey, "");
  assert.deepEqual(settingsForAutosave({ ...draft, personas: [] }, saved).personas, []);
});

test("typing coalesces into one write and flushing saves the latest value before leaving", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const writes: ProviderSettings[] = [];
  const initial = toPublic(defaults);
  const writer = new SettingsAutosave(initial, async (values) => { writes.push(values); return toPublic(values); }, () => {});
  writer.update({ ...initial, model: "j" });
  t.mock.timers.tick(250);
  writer.update({ ...initial, model: "jev-new" });
  t.mock.timers.tick(399);
  assert.equal(writes.length, 0);
  t.mock.timers.tick(1);
  await writer.flush();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].model, "jev-new");
  writer.update({ ...initial, model: "jev-latest" });
  await writer.flush();
  assert.equal(writes[1].model, "jev-latest");
});

test("slow writes serialize the latest edit and an explicit key without leaking it into autosaves", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const writes: ProviderSettings[] = [];
  const initial = toPublic(defaults);
  let active = 0;
  let maximum = 0;
  const writer = new SettingsAutosave(initial, async (values) => {
    maximum = Math.max(maximum, ++active);
    writes.push(values);
    if (writes.length === 1) await gate;
    active--;
    return toPublic(values);
  }, () => {});
  writer.update({ ...initial, model: "first" });
  const saving = writer.flush();
  writer.update({ ...initial, model: "latest" });
  const key = writer.saveKey("test-key-explicit");
  assert.equal(writes.length, 1);
  release();
  await Promise.all([saving, key]);
  assert.equal(maximum, 1);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].apiKey, "");
  assert.equal(writes[1].model, "latest");
  assert.equal(writes[1].apiKey, "test-key-explicit");
  writer.update({ ...initial, model: "after-key" });
  await writer.flush();
  assert.equal(writes[2].apiKey, "");
});

test("failed saves retain edits for retry and never retry a failed key automatically", async () => {
  const initial = toPublic(defaults);
  let fail = true;
  const writes: ProviderSettings[] = [];
  const states: SaveState[] = [];
  const writer = new SettingsAutosave(initial, async (values) => {
    writes.push(values);
    if (fail) throw new Error("offline");
    return toPublic(values);
  }, () => {});
  writer.subscribe((state) => states.push(state));
  writer.update({ ...initial, model: "keep-my-edit" });
  await writer.flush();
  assert.equal(states.at(-1)!.error, true);
  assert.equal(states.at(-1)!.pending, true);
  fail = false;
  await writer.flush();
  assert.equal(writes.at(-1)!.model, "keep-my-edit");
  assert.equal(states.at(-1)!.error, false);
  fail = true;
  await assert.rejects(writer.saveKey("test-key-not-retried"), /Could not save the API key/);
  await writer.flush();
  fail = false;
  writer.update({ ...initial, model: "another-edit" });
  await writer.flush();
  assert.equal(writes.at(-1)!.apiKey, "");
});
