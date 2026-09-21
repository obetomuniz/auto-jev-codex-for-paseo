import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateRoute, pickEffort, pickExecution, pickIntent, pickLane } from "../server/jev";
import { selectCodexEffort, selectCodexModel } from "../server/routing";
import { defaults } from "../shared/settings";
import { answers } from "./fixtures";

test("explicit intent prevents accidental review or implementation routing", () => {
  const thresholds = { staff: 0.7, cheap: 0.8 };
  assert.equal(pickLane(answers({ architecture_decision: { type: "noul", noul: 0.7 } }), thresholds), "staff");
  assert.equal(pickLane(answers({
    intent: { type: "choice", choice: "review", probabilities: { review: 1 }, confidence: 1 },
  }), thresholds), "review");
  assert.equal(pickLane(answers({
    intent: { type: "choice", choice: "discuss", probabilities: { discuss: 1 }, confidence: 1 },
    lane: { type: "choice", choice: "review", probabilities: { review: 1 }, confidence: 1 },
    independent_review: { type: "noul", noul: 1 },
  }), thresholds), "staff");
  assert.equal(pickLane(answers({
    lane: { type: "choice", choice: "review", probabilities: { review: 1 }, confidence: 1 },
    independent_review: { type: "noul", noul: 1 },
  }), thresholds), "lead");
  assert.equal(pickLane(answers({ mechanical_local: { type: "noul", noul: 0.8 } }), thresholds), "cheap");
  assert.equal(pickLane(answers({
    mechanical_local: { type: "noul", noul: 0.8 },
    parallel_edits: { type: "noul", noul: 0.5 },
  }), thresholds), "lead");
  assert.equal(pickLane(answers({
    lane: { type: "choice", choice: "cheap", probabilities: { cheap: 1 }, confidence: 1 },
    parallel_edits: { type: "noul", noul: 0.7 },
  }), thresholds), "lead");
  assert.equal(pickLane(answers({
    lane: { type: "choice", choice: "unknown", probabilities: {}, confidence: 0 },
  }), thresholds), "lead");
});

test("Jev's intent, effort, and execution answers are validated before use", () => {
  assert.equal(pickIntent(answers({ intent: { type: "choice", choice: "discuss", probabilities: {}, confidence: 1 } })), "discuss");
  assert.equal(pickEffort(answers({ effort: { type: "choice", choice: "medium", probabilities: {}, confidence: 1 } })), "medium");
  assert.equal(pickEffort(answers({ effort: { type: "choice", choice: "unsupported", probabilities: {}, confidence: 1 } })), null);
  assert.equal(pickExecution(answers({ execution: { type: "choice", choice: "orchestration-candidate", probabilities: {}, confidence: 1 } })), "orchestration-candidate");
  assert.equal(pickExecution(answers({ execution: { type: "choice", choice: "unsupported", probabilities: {}, confidence: 1 } })), "single-model");
});

test("models and efforts use category defaults or trimmed custom values", () => {
  for (const [lane, suffix] of [["staff", "Staff"], ["review", "Review"], ["cheap", "Cheap"], ["lead", "Lead"]] as const) {
    const modelKey = `autoCodexModel${suffix}` as const;
    const effortKey = `autoCodexEffort${suffix}` as const;
    assert.equal(selectCodexModel(lane, { ...defaults, [modelKey]: " " }), defaults[modelKey]);
    assert.equal(selectCodexModel(lane, { ...defaults, [modelKey]: " custom-model " }), "custom-model");
    assert.equal(selectCodexEffort(lane, { ...defaults, [effortKey]: " " }), defaults[effortKey]);
    assert.equal(selectCodexEffort(lane, { ...defaults, [effortKey]: " high " }), "high");
  }
});

test("classification works without workspace or isolation questions and answers", async (t) => {
  t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof fetch>) => {
    const request = JSON.parse(String(init?.body));
    assert.deepEqual(request.state, { request: "Review the change" });
    assert.equal("isolated_worktree" in request.questions, false);
    assert.equal("parallel_edits" in request.questions, true);
    assert.equal("intent" in request.questions, true);
    assert.equal("effort" in request.questions, true);
    assert.equal("execution" in request.questions, true);
    return Response.json({ answers: answers() });
  });
  assert.deepEqual(await evaluateRoute({ apiKey: "test-key", model: "jev-latest", prompt: "Review the change" }), answers());
});

test("classification failures are propagated instead of selecting an arbitrary model", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ message: "Unauthorized" }, { status: 401 }));
  await assert.rejects(evaluateRoute({ apiKey: "test-key", model: "jev-latest", prompt: "Test" }), /API key rejected/);
});
