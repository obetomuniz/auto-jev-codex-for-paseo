import assert from "node:assert/strict";
import { test } from "node:test";
import { DETECT_DELAY_MS, TaskTypeDetector, type DetectionState } from "../client/task-type-detection";
import { defaults, type Persona } from "../shared/settings";
import type { TaskType } from "../shared/task-types";

const persona = (description: string, values: Partial<Persona> = {}): Persona =>
  ({ ...defaults.personas[0], id: "custom", description, taskTypes: [], taskTypesAuto: true, taskTypesScope: "", ...values });
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(t: import("node:test").TestContext, detect: (description: string) => Promise<TaskType[]>) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: string[] = [];
  const detected: [string, string, TaskType[]][] = [];
  let states: Record<string, DetectionState> = {};
  const detector = new TaskTypeDetector(async (description) => { calls.push(description); return detect(description); },
    (...args) => detected.push(args), (next) => { states = next; });
  t.after(() => detector.dispose());
  return { detector, calls, detected, states: () => states };
}

test("detection waits for the scope to settle and sends each scope once", async (t) => {
  const { detector, calls, detected, states } = setup(t, async () => ["write"]);
  detector.update([persona("Trans")]);
  assert.deepEqual(states(), { custom: { detecting: true } });
  t.mock.timers.tick(DETECT_DELAY_MS - 1);
  detector.update([persona("Translate prose")]);
  t.mock.timers.tick(DETECT_DELAY_MS - 1);
  assert.deepEqual(calls, []);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(calls, ["Translate prose"]);
  assert.deepEqual(detected, [["custom", "Translate prose", ["write"]]]);
  detector.update([persona("Translate prose")]);
  t.mock.timers.tick(DETECT_DELAY_MS);
  assert.deepEqual(calls, ["Translate prose"], "The same scope is not sent again.");
  detector.update([persona("Translate prose", { taskTypes: ["write"], taskTypesScope: "Translate prose" })]);
  assert.deepEqual(states(), {});
});

test("results for a changed scope are dropped and manual or empty scopes are never sent", async (t) => {
  let release!: (types: TaskType[]) => void;
  const { detector, calls, detected, states } = setup(t, () => new Promise((resolve) => { release = resolve; }));
  detector.update([persona("Review code")]);
  t.mock.timers.tick(DETECT_DELAY_MS);
  detector.update([persona("Review code and docs")]);
  release(["review"]);
  await flush();
  assert.deepEqual(detected, []);
  assert.equal(states().custom.detecting, true, "The new scope is pending.");
  detector.update([persona("Review code and docs", { taskTypesAuto: false, taskTypes: ["review"] }), { ...persona("   "), id: "empty" }]);
  t.mock.timers.tick(DETECT_DELAY_MS);
  assert.deepEqual(calls, ["Review code"]);
  assert.deepEqual(states(), {});
});

test("errors are shown for the failed scope and retry sends it again", async (t) => {
  let fail = true;
  const { detector, calls, detected, states } = setup(t, async () => { if (fail) throw new Error("TypeSafe 503"); return ["design"]; });
  detector.update([persona("Choose architecture")]);
  t.mock.timers.tick(DETECT_DELAY_MS);
  await flush();
  assert.deepEqual(states(), { custom: { detecting: false, error: "TypeSafe 503" } });
  detector.update([persona("Choose architecture")]);
  t.mock.timers.tick(DETECT_DELAY_MS);
  assert.equal(calls.length, 1, "A failed scope is not retried automatically.");
  fail = false;
  detector.retry("custom");
  detector.update([persona("Choose architecture")]);
  t.mock.timers.tick(DETECT_DELAY_MS);
  await flush();
  assert.equal(calls.length, 2);
  assert.deepEqual(detected, [["custom", "Choose architecture", ["design"]]]);
  detector.update([]);
  assert.deepEqual(states(), {});
});
