import assert from "node:assert/strict";
import { test } from "node:test";
import { personaQuestions, matchingPersona, taskTypeOwners } from "../server/persona-classification";
import { routePrompt } from "../server/routing";
import { defaults, MAX_PERSONAS } from "../shared/settings";
import { answers, wireAnswers } from "./fixtures";
import { ROUTE_QUESTIONS } from "../server/classifier";
import { LAYA_QUESTIONS } from "../server/laya-questions";

const reviewer = { ...defaults.personas[2], id: "security-reviewer", name: "Security reviewer",
  description: "Review authentication and tenant isolation for vulnerabilities.", provider: "claude", model: "custom-model", effort: "medium" };

test("routing uses the complete visible scope and excludes instructions, credentials and execution setup", () => {
  const persona = { ...reviewer, name: "n".repeat(80), description: "d".repeat(240), instructions: "private instructions", apiKey: "must-not-leave" };
  const roster = personaQuestions([persona, { ...reviewer, id: "disabled", enabled: false }, { ...reviewer, id: "manual", description: "" }]);
  assert.deepEqual(roster.ids, [persona.id]);
  const instruction = roster.questions.persona_0.instructions;
  assert.ok(instruction.endsWith(persona.description));
  for (const value of [persona.name, persona.apiKey, persona.instructions, persona.model, persona.provider, "disabled"]) assert.ok(!JSON.stringify(roster.questions).includes(value));
  assert.deepEqual(personaQuestions([{ ...persona, id: "critic" }]).questions, roster.questions);
  const many = Array.from({ length: MAX_PERSONAS }, (_, i) => ({ ...persona, id: "role-" + i }));
  assert.equal(Object.keys(personaQuestions(many).questions).length, MAX_PERSONAS);
  assert.throws(() => personaQuestions([...many, { ...persona, id: "extra" }]));
  assert.throws(() => personaQuestions([{ ...persona, description: "d".repeat(241) }]));
});

test("selection ranks valid scores without a minimum and excludes disabled or manual-only personas", () => {
  const second = { ...reviewer, id: "accessibility-reviewer" };
  assert.equal(matchingPersona([reviewer], { [reviewer.id]: 0 }), reviewer.id);
  assert.equal(matchingPersona([reviewer, second], { [reviewer.id]: 0.02, [second.id]: 0.01 }), reviewer.id);
  assert.equal(matchingPersona([reviewer, second], { [reviewer.id]: 0, [second.id]: 0 }), second.id);
  const scores = { [reviewer.id]: 0.9, [second.id]: 0.9, unknown: 1, critic: 1 };
  assert.equal(matchingPersona([reviewer, second], scores), second.id);
  assert.equal(matchingPersona([second, reviewer], scores), second.id);
  assert.equal(matchingPersona([{ ...reviewer, enabled: false }], scores), undefined);
  assert.equal(matchingPersona([{ ...reviewer, description: "" }], scores), undefined);
  for (const score of [NaN, Infinity, -1, 1.1]) assert.equal(matchingPersona([reviewer], { [reviewer.id]: score }), undefined);
});

test("task depth filters scope candidates uniformly and discloses insufficient capacity", async (t) => {
  const shallow = { ...reviewer, id: "quick", taskDepth: "low" as const, effort: "xhigh" };
  const deep = { ...reviewer, id: "deep", taskDepth: "high" as const, effort: "" };
  const scores = { quick: 0.99, deep: 0.8 };
  assert.equal(matchingPersona([shallow, deep], scores, "low"), "quick");
  assert.equal(matchingPersona([shallow, deep], scores, "high"), "deep");
  assert.equal(matchingPersona([shallow, deep], scores, "xhigh"), "deep");
  assert.equal(matchingPersona([{ ...shallow, id: "critic" }, { ...deep, id: "reporter" }], { critic: 0.99, reporter: 0.8 }, "high"), "reporter");
  let effort = "xhigh";
  const settings = { ...defaults, apiKey: "test-key", personas: [shallow, deep] };
  t.mock.method(globalThis, "fetch", async () => Response.json({ answers: wireAnswers(answers({
    effort: { type: "choice", choice: effort, probabilities: { [effort]: 1 }, confidence: 1 }, personaScores: scores,
  }), settings.personas) }));
  const limited = await routePrompt("Review", [], settings);
  assert.equal(limited.personaId, "deep");
  assert.match(limited.notices.join(" "), /No Auto persona.*Expert.*Deep/);
  assert.equal(limited.effort, "");
  const manual = await routePrompt("Review", [], settings, "quick");
  assert.equal(manual.personaId, "quick");
  assert.deepEqual(manual.notices, []);
  effort = "invalid";
  await assert.rejects(routePrompt("Review", [], settings), /unknown task depth/);
});

test("Jev routes with only user-defined personas, preserves intent and honors manual selection", async (t) => {
  let fit = 0.9;
  let intent = "review";
  let requests = 0;
  const manual = { ...reviewer, id: "manual", description: "" };
  const settings = { ...defaults, apiKey: "test-key", personas: [reviewer, manual] };
  t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof fetch>) => {
    requests++;
    const request = JSON.parse(String(init?.body));
    assert.deepEqual(Object.keys(request.state), ["request"]);
    if (request.questions.persona_0) assert.ok(request.questions.persona_0.instructions.includes(reviewer.description));
    else assert.equal(requests, 3);
    return Response.json({ answers: { ...wireAnswers(answers({
      intent: { type: "choice", choice: intent, confidence: 1, probabilities: { [intent]: 1 } },
      personaScores: { [reviewer.id]: fit },
    }), settings.personas), persona_99: { type: "noul", noul: 1 } } });
  });
  const route = await routePrompt("Audit tenant isolation", [], settings);
  assert.equal(route.personaId, reviewer.id);
  assert.equal(route.provider, reviewer.provider);
  assert.equal(route.model, reviewer.model);
  assert.equal(route.effort, reviewer.effort);
  assert.equal(route.instructions, reviewer.instructions);
  assert.equal(route.intent, "review");
  assert.equal(route.plan, false);
  assert.equal(requests, 1);
  fit = 0.49;
  assert.equal((await routePrompt("testing", [], settings)).personaId, reviewer.id);
  assert.equal((await routePrompt("Audit", [], settings, "manual")).personaId, "manual");
  fit = 1;
  intent = "invalid";
  await assert.rejects(routePrompt("Audit", [], settings), /unknown intent/);
});

test("Auto explains an empty eligible roster while manual selection remains available", async (t) => {
  const manual = { ...reviewer, id: "manual", description: "" };
  const settings = { ...defaults, apiKey: "test-key", personas: [{ ...reviewer, enabled: false }, manual] };
  t.mock.method(globalThis, "fetch", async () => Response.json({ answers: wireAnswers(answers(), settings.personas) }));
  await assert.rejects(routePrompt("testing", [], settings), /Auto needs an enabled persona with a Scope/);
  assert.equal((await routePrompt("testing", [], settings, manual.id)).personaId, manual.id);
});

test("missing or malformed persona scores fail closed", async (t) => {
  let score: unknown;
  t.mock.method(globalThis, "fetch", async () => Response.json({ answers: { ...wireAnswers(), persona_0: score } }));
  const settings = { ...defaults, apiKey: "test-key", personas: [reviewer] };
  for (score of [undefined, { noul: "1" }, { noul: 2 }]) {
    await assert.rejects(routePrompt("Audit", [], settings), /persona_0.*not a noul/);
  }
});

test("classifier questions judge the latest request so earlier topics cannot carry intent or persona", () => {
  const scope = personaQuestions([reviewer]).questions.persona_0.instructions;
  assert.match(scope, /latest request/);
  assert.match(scope, /earlier topics do not carry over/);
  assert.match(ROUTE_QUESTIONS.intent.instructions.focus, /status request, or new topic is discuss even after earlier implementation requests/);
  assert.ok(ROUTE_QUESTIONS.intent.criteria.discuss.examples.includes("What is the status?"));
  assert.match(LAYA_QUESTIONS.intent.instructions, /status requests stay discuss after earlier implementation requests/);
});

test("the fixed task type bounds scope scores, lets untagged personas compete and reports missing owners", async (t) => {
  const tagged = (id: string, types: ("review" | "write" | "report")[], extra = {}) => ({ ...reviewer, id, description: id + " scope",
    taskTypes: types, taskTypesAuto: true, taskTypesScope: id + " scope", ...extra });
  const critic = tagged("critic", ["review"]);
  const writer = tagged("writer", ["write"]);
  const untagged = { ...tagged("fresh", ["write"]), taskTypesScope: "an older scope" };
  const scores = { critic: 0.2, writer: 0.9, fresh: 0.1 };
  assert.equal(matchingPersona([critic, writer], scores, "low", "review"), "critic", "A higher score cannot cross task types.");
  assert.equal(matchingPersona([critic, writer, untagged], { ...scores, fresh: 0.5 }, "low", "review"), "fresh", "Stale tags compete everywhere.");
  assert.equal(matchingPersona([critic, writer], scores, "low", "report"), "writer", "Without an owner, scores decide.");
  assert.equal(matchingPersona([critic, writer], scores, "low", "other"), "writer");
  assert.equal(matchingPersona([critic, writer], scores, "low"), "writer");
  const manual = { ...writer, description: "edited scope", taskTypes: ["review" as const], taskTypesAuto: false };
  assert.equal(matchingPersona([critic, manual], { critic: 0.2, writer: 0.9 }, "low", "review"), "writer", "Manual tags survive scope edits.");
  assert.deepEqual(taskTypeOwners([critic, { ...writer, enabled: false }, untagged], "write").map((persona) => persona.id), []);

  let taskType = "report";
  const settings = { ...defaults, apiKey: "test-key", personas: [critic, writer] };
  t.mock.method(globalThis, "fetch", async () => Response.json({ answers: wireAnswers(answers({
    taskType: { type: "choice", choice: taskType, probabilities: { [taskType]: 1 }, confidence: 1 }, personaScores: scores,
  }), settings.personas) }));
  const fallback = await routePrompt("Status?", [], settings);
  assert.equal(fallback.taskType, "report");
  assert.equal(fallback.personaId, "writer");
  assert.match(fallback.notices.join(" "), /No persona is assigned to Report tasks/);
  taskType = "review";
  const owned = await routePrompt("Is this good?", [], settings);
  assert.equal(owned.personaId, "critic");
  assert.deepEqual(owned.notices, []);
  taskType = "other";
  assert.deepEqual((await routePrompt("hello", [], settings)).notices, [], "Other never reports a missing owner.");
  taskType = "report";
  const selected = await routePrompt("Status?", [], settings, "critic");
  assert.equal(selected.personaId, "critic");
  assert.deepEqual(selected.notices, [], "Manual selection ignores the task type.");
  taskType = "invalid";
  await assert.rejects(routePrompt("Status?", [], settings), /unknown task type/);
});
