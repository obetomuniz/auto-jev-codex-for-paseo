import assert from "node:assert/strict";
import { test } from "node:test";
import { detectTaskTypes, SCOPE_TYPE_QUESTIONS } from "../server/scope-types";
import { LayaClassifier, disposeLaya } from "../server/laya";
import { defaults } from "../shared/settings";
import { detectTaskTypesRpc } from "../shared/task-types";

const scope = "Translate technical prose into Portuguese.";
const answer = (choice: string) => ({ answers: { taskType: { type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 1 } } });

test("Jev scope detection sends only the scope and the fixed task-type question", async (t) => {
  const settings = { ...defaults, apiKey: "secret-key", presets: [{ ...defaults.presets[0], instructions: "private instructions" }] };
  const requests: { body: Record<string, unknown> }[] = [];
  let choice = "write";
  t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof fetch>) => {
    requests.push({ body: JSON.parse(String(init?.body)) });
    return Response.json(answer(choice));
  });
  assert.deepEqual(await detectTaskTypes(`  ${scope}  `, settings), ["write"]);
  assert.deepEqual(requests[0].body.state, { scope });
  assert.deepEqual(requests[0].body.questions, JSON.parse(JSON.stringify(SCOPE_TYPE_QUESTIONS.jev)));
  const body = JSON.stringify(requests[0].body);
  for (const value of ["secret-key", "private instructions", settings.presets[0].description]) assert.ok(!body.includes(value));
  choice = "invalid";
  await assert.rejects(detectTaskTypes(scope, settings), /unknown task type/);
  assert.deepEqual(await detectTaskTypes("   ", settings), []);
  assert.equal(requests.length, 2, "An empty scope is never sent.");
  await assert.rejects(detectTaskTypes("x".repeat(241), settings), /240 characters/);
  await assert.rejects(detectTaskTypes(scope, { ...settings, apiKey: "" }), /Configure the TypeSafe key/);
});

test("Laya scope detection uses the local worker with the same state", async (t) => {
  const calls: Parameters<LayaClassifier["ask"]>[0][] = [];
  t.mock.method(LayaClassifier.prototype, "ask", async (input: Parameters<LayaClassifier["ask"]>[0]) => { calls.push(input); return answer("review"); });
  t.after(disposeLaya);
  const settings = { ...defaults, classifier: "laya" as const, apiKey: "secret-key" };
  assert.deepEqual(await detectTaskTypes(scope, settings), ["review"]);
  assert.deepEqual(calls[0].state, { scope });
  assert.deepEqual(calls[0].questions, SCOPE_TYPE_QUESTIONS.laya);
  assert.ok(!JSON.stringify(calls[0]).includes("secret-key"));
});

test("the detection RPC bounds scope input", () => {
  assert.equal(detectTaskTypesRpc.input.safeParse({ description: "x".repeat(240) }).success, true);
  assert.equal(detectTaskTypesRpc.input.safeParse({ description: "x".repeat(241) }).success, false);
  assert.equal(detectTaskTypesRpc.output.safeParse({ taskTypes: ["write", "unknown"] }).success, false);
});
