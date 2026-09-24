import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateRoute } from "../server/jev";
import { pickEffort, pickExecution, pickIntent } from "../server/classifier";
import { routePrompt } from "../server/routing";
import { defaults } from "../shared/settings";
import { answers, wireAnswers } from "./fixtures";
import { parseWorkspaceState } from "../server/workspace-state";

test("Auto uses editable scope fit for every persona without changing permissions", async (t) => {
  const settings = { ...defaults, apiKey: "test-key", personas: defaults.personas.map((persona) => persona.id === "writer"
    ? { ...persona, name: "My reviewer", description: "Assess code quality and correctness. Review existing changes without edits.", provider: "claude", model: "configured-model", effort: "medium" }
    : { ...persona }) };
  let winner = "writer";
  t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof fetch>) => {
    const request = JSON.parse(String(init?.body));
    assert.equal("lane" in request.questions, false);
    if (request.questions.persona_0) assert.ok(JSON.stringify(request.questions).includes(settings.personas.find((persona) => persona.id === "writer")!.description));
    return Response.json({ answers: wireAnswers(answers({
      intent: { type: "choice", choice: "review", probabilities: { review: 1 }, confidence: 1 },
      personaScores: { [winner]: 0.95 },
    }), settings.personas) });
  });
  const route = await routePrompt("Are the current changes good?", [], settings);
  assert.equal(route.personaId, "writer");
  assert.equal(route.provider, "claude");
  assert.equal(route.model, "configured-model");
  assert.equal(route.effort, "medium");
  assert.equal(route.intent, "review");
  assert.equal(route.plan, false);
  winner = "critic";
  assert.equal((await routePrompt("Review", [], settings, "writer")).personaId, "writer");
  settings.personas.find((persona) => persona.id === "critic")!.enabled = false;
  assert.notEqual((await routePrompt("Review", [], settings)).personaId, "critic");
});

test("intent, effort, and execution answers are validated before use", () => {
  assert.equal(pickIntent(answers({ intent: { type: "choice", choice: "discuss", probabilities: {}, confidence: 1 } })), "discuss");
  assert.throws(() => pickIntent(answers({ intent: { type: "choice", choice: "unknown", probabilities: {}, confidence: 1 } })), /unknown intent/);
  assert.equal(pickEffort(answers({ effort: { type: "choice", choice: "medium", probabilities: {}, confidence: 1 } })), "medium");
  assert.equal(pickEffort(answers({ effort: { type: "choice", choice: "unsupported", probabilities: {}, confidence: 1 } })), null);
  assert.equal(pickExecution(answers({ execution: { type: "choice", choice: "orchestration-candidate", probabilities: {}, confidence: 1 } })), "orchestration-candidate");
  assert.equal(pickExecution(answers({ execution: { type: "choice", choice: "unsupported", probabilities: {}, confidence: 1 } })), "single-model");
});

test("classification sends configured scopes without workspace or isolation questions", async (t) => {
  t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof fetch>) => {
    const request = JSON.parse(String(init?.body));
    assert.deepEqual(request.state, { request: "Review the change" });
    assert.equal("isolated_worktree" in request.questions, false);
    assert.equal("intent" in request.questions, true);
    assert.equal("execution" in request.questions, true);
    assert.equal("persona_0" in request.questions, true);
    return Response.json({ answers: wireAnswers() });
  });
  assert.deepEqual(await evaluateRoute({ apiKey: "test-key", model: "jev-latest", prompt: "Review the change" }), answers());
});

test("classification failures are propagated instead of selecting an arbitrary model", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ message: "Unauthorized" }, { status: 401 }));
  await assert.rejects(evaluateRoute({ apiKey: "test-key", model: "jev-latest", prompt: "Test" }), /API key rejected/);
});

test("Jev validates aggregate workspace context without passing through extra properties", async (t) => {
  const workspace = parseWorkspaceState("2300\t418\tprivate-path\0", "");
  t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof fetch>) => {
    const request = JSON.parse(String(init?.body));
    assert.deepEqual(request.state.workspace, workspace);
    assert.ok(!JSON.stringify(request.state).includes("private"));
    return Response.json({ answers: wireAnswers() });
  });
  const extra = { ...workspace, raw: "private diff" };
  await evaluateRoute({ apiKey: "test-key", model: "jev", prompt: "Review", workspace: extra });
});

test("classifier rejects array-shaped probability maps", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ answers: { ...wireAnswers(), intent: { choice: "implement", confidence: 1, probabilities: [1] } } }));
  await assert.rejects(evaluateRoute({ apiKey: "test-key", model: "jev-latest", prompt: "Fix it" }), /not a choice/);
});
