import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test, type TestContext } from "node:test";
import type { PaseoApi, PaseoAgentCreateOptions, PaseoAgentTimelineEvent, PaseoAgentSendOptions, PaseoAgentRespondToPermissionOptions } from "@getpaseo/client";
import type { ProviderEvent, ProviderConnection, ProviderPersistence } from "@getpaseo/plugin/server/provider";
import { PaseoExecution } from "../server/paseo-execution";
import { createAutoModeProvider } from "../server/provider";
import { defaults } from "../shared/settings";
import { answers, wireAnswers } from "./fixtures";
import { CodexAppServer, type CodexNotification } from "../server/codex-app-server";

const config = { cwd: process.cwd(), env: {}, mcpServers: {}, settings: {}, persist: true };
const persona = { ...defaults.personas[0], provider: "claude", model: "vendor/model", effort: "deep", instructions: "Persona instructions." };
const policy = { provider: "claude", intent: "implement" as const, plan: false, fast: false, fullAccess: true, cwd: config.cwd };
const terminalEvents = [
  { type: "turn_failed", provider: "claude", error: "Provider failed" },
  { type: "turn_canceled", provider: "claude", reason: "Canceled" },
  { type: "turn_completed", provider: "claude" },
] as const;

function fakePaseo() {
  let listener: (event: PaseoAgentTimelineEvent) => void = () => {};
  const creations: PaseoAgentCreateOptions[] = [];
  const sends: Array<{ text: string; options?: PaseoAgentSendOptions }> = [];
  const responses: PaseoAgentRespondToPermissionOptions[] = [];
  let archived = 0;
  let unsubscribed = 0;
  let sendHook: (() => void) | undefined;
  let createGate: Promise<void> | undefined;
  let subscriptionGate: Promise<void> | undefined;
  let sendGate: Promise<void> | undefined;
  let archiveGate: Promise<void> | undefined;
  let archiveError: Error | undefined;
  let seq = 0;
  const api = {
    providers: {
      listModels: async () => ({ models: [{ id: "vendor/model", label: "Model", provider: "claude", thinkingOptions: [{ id: "deep", label: "Deep" }] }] }),
      listModes: async () => ({ modes: ["plan", "default", "acceptEdits", "auto", "bypassPermissions"].map((id) => ({ id, label: id })) }),
      listFeatures: async () => ({ features: [] }),
    },
    agents: {
      create: async (options: PaseoAgentCreateOptions) => {
        creations.push(options);
        await createGate;
        return {
          id: `native-${creations.length}`,
          send: async (text: string, options?: PaseoAgentSendOptions) => { sends.push({ text, options }); sendHook?.(); await sendGate; },
          archive: async () => { archived++; await archiveGate; if (archiveError) throw archiveError; },
          respondToPermission: async (response: PaseoAgentRespondToPermissionOptions) => { responses.push(response); },
          timeline: {
            subscribe: (handler: typeof listener) => { listener = handler; return Object.assign(() => { unsubscribed++; }, { ready: subscriptionGate ?? Promise.resolve() }); },
          },
        };
      },
    },
  } as unknown as PaseoApi;
  return {
    api, creations, sends, responses,
    get archived() { return archived; },
    get unsubscribed() { return unsubscribed; },
    onSend(callback: () => void) { sendHook = callback; },
    gateCreate(promise: Promise<void>) { createGate = promise; },
    gateSubscription(promise: Promise<void>) { subscriptionGate = promise; },
    gateSend(promise: Promise<void>) { sendGate = promise; },
    gateArchive(promise: Promise<void>) { archiveGate = promise; },
    failArchive(error: Error | undefined) { archiveError = error; },
    event(event: Exclude<PaseoAgentTimelineEvent["event"], { type: "replacement" }>, itemSeq = ++seq) {
      listener({ agentId: `native-${creations.length}`, timestamp: new Date().toISOString(), seq: itemSeq, epoch: "epoch", event });
    },
  };
}

async function open(connection: ProviderConnection, persistence?: ProviderPersistence) {
  await connection.send({ type: "session.open", sessionId: "s", requestId: "open", config, history: "skip", persistence });
}
async function prompt(connection: ProviderConnection, id = "message", text = "Implement the change") {
  await connection.send({ type: "session.prompt", sessionId: "s", prompt: { clientMessageId: id, delivery: "auto", input: { type: "message", content: [{ type: "text", text }] } } });
}
async function providerHarness(t: TestContext, fullAccess = true) {
  const fake = fakePaseo();
  const settings = { ...defaults, apiKey: "test-key", personas: defaults.personas.map((item) => item.id === "tech-lead" ? { ...persona } : { ...item }) };
  t.mock.method(fs, "readFile", async () => JSON.stringify(settings));
  const classified: string[] = [];
  let classification = answers();
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => { classified.push(String(init?.body)); return Response.json({ answers: wireAnswers(classification, settings.personas) }); });
  const codexStart = t.mock.method(CodexAppServer.prototype, "start", async () => {});
  t.mock.method(CodexAppServer.prototype, "close", async () => {});
  const connection = await createAutoModeProvider(() => fake.api).connect({ versions: [1], capabilities: ["prompt.message", "permission", "session.persistence", "session.configure"] });
  t.after(() => connection.close());
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  await open(connection);
  if (fullAccess) await connection.send({ type: "session.configure", sessionId: "s", requestId: "access", changes: { settings: { permissions: "full-access" } } });
  return { fake, settings, connection, events, classified, codexStart, classify(value: ReturnType<typeof answers>) { classification = value; } };
}

test("native execution validates the model, subscribes first, forwards images and orders early completion", async () => {
  const fake = fakePaseo();
  const events: ProviderEvent[] = [];
  const execution = new PaseoExecution(fake.api, "s", (event) => events.push(event));
  fake.onSend(() => {
    fake.event({ type: "timeline", provider: "claude", item: { type: "assistant_message", text: "Done" } });
    fake.event({ type: "turn_completed", provider: "claude" });
  });
  let accepted = false;
  await execution.start({ config, persona, policy, context: [{ id: "old", role: "user", text: "Keep CSV support" }], text: "Add JSON", images: [{ data: "AQID", mimeType: "image/png" }], clientMessageId: "message", accepted() { accepted = true; } });
  assert.equal(accepted, true);
  assert.equal(fake.creations[0].config.provider, "claude/vendor/model");
  assert.equal(fake.creations[0].config.thinkingOptionId, "deep");
  assert.match(fake.creations[0].config.systemPrompt ?? "", /Persona instructions/);
  assert.match(fake.sends[0].text, /Keep CSV support/);
  assert.deepEqual(fake.sends[0].options?.images, [{ data: "AQID", mimeType: "image/png" }]);
  assert.deepEqual(events.map((event) => event.type === "session.turn" ? event.state : event.type), ["session.prompt_result", "started", "timeline.item", "timeline.item", "completed"]);
  assert.equal(fake.unsubscribed, 1);
  await execution.close();
  assert.equal(fake.archived, 1);
});

test("unavailable models and subscription failures never send a prompt", async () => {
  for (const override of [{ model: "missing" }]) {
    const fake = fakePaseo();
    const execution = new PaseoExecution(fake.api, "s", () => {});
    await assert.rejects(execution.start({ config, persona: { ...persona, ...override }, policy, context: [], text: "Run", images: [], clientMessageId: "m", accepted() {} }), /not available/);
    assert.equal(fake.creations.length, 0);
  }
  const fake = fakePaseo();
  fake.gateSubscription(Promise.reject(new Error("Subscription unavailable")));
  const execution = new PaseoExecution(fake.api, "s", () => {});
  await assert.rejects(execution.start({ config, persona, policy, context: [], text: "Run", images: [], clientMessageId: "m", accepted() {} }), /Subscription unavailable/);
  assert.equal(fake.sends.length, 0);
  assert.equal(fake.archived, 1);
});

test("optional reasoning and Fast settings use only current model capabilities", async (t) => {
  for (const available of [true, false]) {
    const fake = fakePaseo();
    t.mock.method(fake.api.providers, "listFeatures", async () => ({ features: available
      ? [{ type: "toggle", id: "fast_mode", label: "Fast", value: false }] : [] }));
    const events: ProviderEvent[] = [];
    const execution = new PaseoExecution(fake.api, "s", (event) => events.push(event));
    await execution.start({ config, persona: { ...persona, effort: available ? "deep" : "retired" },
      policy: { ...policy, fast: true, fullAccess: false }, context: [], text: "Run", images: [], clientMessageId: "m", accepted() {} });
    assert.deepEqual(fake.creations[0].config.featureValues, available ? { fast_mode: true } : {});
    assert.equal(fake.creations[0].config.thinkingOptionId, available ? "deep" : undefined);
    assert.equal(fake.creations[0].config.modeId, "auto");
    assert.equal(fake.sends.length, 1);
    if (!available) assert.ok(events.some((event) => event.type === "timeline.item" && event.item.type === "notification"
      && /reasoning setting is unavailable/.test(event.item.message) && /normal speed/.test(event.item.message)));
    await execution.close();
  }
});

test("Fast off overrides a provider's enabled Fast default", async (t) => {
  const fake = fakePaseo();
  t.mock.method(fake.api.providers, "listFeatures", async () => ({ features: [{ type: "toggle", id: "fast_mode", label: "Fast", value: true }] }));
  const execution = new PaseoExecution(fake.api, "s", () => {});
  await execution.start({ config, persona, policy: { ...policy, fast: false }, context: [], text: "Run", images: [], clientMessageId: "m", accepted() {} });
  assert.deepEqual(fake.creations[0].config.featureValues, { fast_mode: false });
  await execution.close();
});

test("native review and discussion honor classifier Plan and manual overrides independently of intent", async (t) => {
  const h = await providerHarness(t, false);
  await h.connection.send({ type: "session.configure", sessionId: "s", requestId: "persona", changes: { model: "tech-lead", settings: { modelScope: "pinned" } } });
  const scenarios = [
    { intent: "review", plan: "off", mode: "auto", workMode: "", expected: "auto" },
    { intent: "discuss", plan: "off", mode: "auto", workMode: "", expected: "auto" },
    { intent: "review", plan: "on", mode: "auto", workMode: "", expected: "plan" },
    { intent: "review", plan: "on", mode: "default", workMode: "", expected: "auto" },
    { intent: "review", plan: "off", mode: "plan", workMode: "", expected: "plan" },
    { intent: "review", plan: "off", mode: "auto", workMode: "default", expected: "default" },
  ] as const;
  for (const [index, scenario] of scenarios.entries()) {
    h.settings.personas.find((item) => item.id === "tech-lead")!.workMode = scenario.workMode;
    await h.connection.send({ type: "session.configure", sessionId: "s", requestId: `mode-${index}`, changes: { mode: scenario.mode } });
    h.classify(answers({
      intent: { type: "choice", choice: scenario.intent, confidence: 1, probabilities: { [scenario.intent]: 1 } },
      plan: { type: "choice", choice: scenario.plan, confidence: 1, probabilities: { [scenario.plan]: 1 } },
    }));
    const firstEvent = h.events.length;
    await prompt(h.connection, `review-${index}`, "Review this change");
    const created = h.fake.creations.at(-1)!.config;
    assert.equal(created.modeId, scenario.expected, JSON.stringify(scenario));
    assert.deepEqual(created.options, {});
    assert.match(created.systemPrompt ?? "", /without modifying workspace files/);
    const notices = h.events.slice(firstEvent).flatMap((event) => event.type === "timeline.item" && event.item.type === "notification" ? [event.item.message] : []);
    assert.equal(notices.length, 1);
    assert.ok(notices[0].includes(`Mode: ${scenario.expected}`));
    assert.ok(!/requested:|Intent confidence|Classification:|Context:/.test(notices[0]));
    h.fake.event({ type: "turn_completed", provider: "claude" });
  }
  assert.equal(h.codexStart.mock.callCount(), 0);
});

test("Auto review starts Critic and emits one notice with the applied native settings", async (t) => {
  const h = await providerHarness(t, false);
  Object.assign(h.settings.personas.find((item) => item.id === "critic")!, {
    ...persona, id: "critic", name: "My reviewer", instructions: "Check regressions in the diff.", workMode: "default", effort: "retired-effort",
  });
  h.classify(answers({
    intent: { type: "choice", choice: "review", confidence: 1, probabilities: { review: 1 } },
    personaScores: { critic: 1 },
  }));
  await prompt(h.connection, "review", "Actually, are the current changes good?");
  assert.equal(h.codexStart.mock.callCount(), 0);
  const created = h.fake.creations[0].config;
  assert.match(created.systemPrompt ?? "", /Check regressions in the diff/);
  assert.equal(created.modeId, "default");
  assert.equal(created.thinkingOptionId, undefined);
  const notices = h.events.flatMap((event) => event.type === "timeline.item" && event.item.type === "notification" ? [event.item.message] : []);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /Auto: My reviewer/);
  assert.match(notices[0], /Review/);
  assert.match(notices[0], /Mode: default/);
  assert.match(notices[0], /Reasoning: provider default/);
  assert.match(notices[0], /saved reasoning setting is unavailable/);
  assert.ok(!notices[0].includes("Writer"));
});

test("cancel during native creation archives the idle agent without sending work", async () => {
  const fake = fakePaseo();
  let release!: () => void;
  fake.gateCreate(new Promise<void>((resolve) => { release = resolve; }));
  const execution = new PaseoExecution(fake.api, "s", () => {});
  const pending = execution.start({ config, persona, policy, context: [], text: "Run", images: [], clientMessageId: "m", accepted() {} });
  await new Promise((resolve) => setImmediate(resolve));
  await execution.close();
  release();
  await assert.rejects(pending, /canceled/);
  assert.equal(fake.sends.length, 0);
  assert.equal(fake.archived, 1);
});

test("a terminal event during subscription startup prevents prompt delivery", async () => {
  for (const terminal of terminalEvents) {
    const fake = fakePaseo();
    let release!: () => void;
    fake.gateSubscription(new Promise<void>((resolve) => { release = resolve; }));
    const events: ProviderEvent[] = [];
    const execution = new PaseoExecution(fake.api, "s", (event) => events.push(event));
    let accepted = false;
    const pending = execution.start({ config, persona, policy, context: [], text: "Run", images: [], clientMessageId: "m", accepted() { accepted = true; } });
    await new Promise((resolve) => setImmediate(resolve));
    fake.event(terminal);
    release();
    await assert.rejects(pending, /stopped before prompt delivery/);
    assert.equal(accepted, false);
    assert.equal(fake.sends.length, 0);
    assert.equal(fake.archived, 1);
    assert.equal(fake.unsubscribed, 1);
    assert.deepEqual(events, []);
  }
});

test("terminal events resolve pending questions once and reject late answers", async () => {
  for (const terminal of terminalEvents) {
    const fake = fakePaseo();
    const events: ProviderEvent[] = [];
    const execution = new PaseoExecution(fake.api, "s", (event) => events.push(event));
    await execution.start({ config, persona, policy, context: [], text: "Run", images: [], clientMessageId: "m", accepted() {} });
    fake.event({ type: "permission_requested", provider: "claude", request: { id: "question", provider: "claude", kind: "question", name: "Question" } });
    const id = "paseo:native-1:question";
    assert.equal(execution.hasPermission(id), true);
    fake.event(terminal);
    assert.equal(execution.hasPermission(id), false);
    await assert.rejects(execution.respond(id, { behavior: "allow" }), /no longer pending/);
    await execution.close();
    assert.equal(fake.responses.length, 0);
    assert.equal(events.filter((event) => event.type === "session.permission_resolved").length, 1);
    const resolvedIndex = events.findIndex((event) => event.type === "session.permission_resolved");
    const terminalIndex = events.findIndex((event) => event.type === "session.turn" && event.state !== "started");
    assert.ok(resolvedIndex < terminalIndex);
  }
});

test("native providers use their published work and plan modes without requiring Full access", async () => {
  for (const provider of ["claude", "opencode", "custom-vendor"]) {
    for (const fullAccess of [false, true]) {
      for (const plan of [false, true]) {
        const fake = fakePaseo();
        const execution = new PaseoExecution(fake.api, "s", () => {});
        await execution.start({ config, persona: { ...persona, provider }, policy: { ...policy, provider, fullAccess, plan }, context: [], text: "Run", images: [], clientMessageId: "m", accepted() {} });
        assert.equal(fake.creations[0].config.modeId, plan ? "plan" : fullAccess ? "bypassPermissions" : "auto");
        assert.equal(fake.sends.length, 1);
        if (plan) {
          assert.match(fake.creations[0].config.systemPrompt ?? "", /without modifying workspace files/);
          assert.deepEqual(fake.creations[0].config.options, {});
        }
        await execution.close();
      }
    }
  }
});

test("Auto starts a configured non-Codex provider and preserves questions without treating them as completion", async (t) => {
  const h = await providerHarness(t, false);
  await prompt(h.connection);
  assert.equal(h.codexStart.mock.callCount(), 0);
  assert.equal(h.fake.creations.length, 1);
  assert.equal(h.fake.creations[0].config.modeId, "auto");
  h.fake.event({ type: "permission_requested", provider: "claude", request: {
    id: "questions", provider: "claude", name: "Questions", kind: "question", input: { questions: [{ header: "Format", question: "Choose?", options: [] }] },
  } });
  h.fake.event({ type: "attention_required", provider: "claude", reason: "permission", timestamp: new Date().toISOString(), shouldNotify: true });
  assert.equal(h.events.filter((event) => event.type === "session.turn" && event.state === "completed").length, 0);
  const response = { behavior: "allow" as const, updatedInput: { answers: { Format: "JSON" } } };
  await h.connection.send({ type: "session.permission", sessionId: "s", permissionId: "paseo:native-1:questions", response });
  assert.deepEqual(h.fake.responses[0], { requestId: "questions", response });
  h.fake.event({ type: "timeline", provider: "claude", item: { type: "assistant_message", text: "Kept CSV and added JSON." } }, 4);
  h.fake.event({ type: "timeline", provider: "claude", item: { type: "assistant_message", text: "Kept CSV and added JSON. Tested." } }, 4);
  h.fake.event({ type: "timeline", provider: "claude", item: { type: "reasoning", text: "PRIVATE REASONING" } });
  h.fake.event({ type: "turn_completed", provider: "claude" });
  await prompt(h.connection, "follow-up", "Add XML too");
  assert.match(h.fake.sends[1].text, /Kept CSV and added JSON. Tested/);
  assert.equal(h.fake.sends[1].text.includes("PRIVATE REASONING"), false);
  assert.equal(h.classified[1].includes("PRIVATE REASONING"), false);
  assert.equal((h.fake.sends[1].text.match(/Kept CSV and added JSON/g) ?? []).length, 1);
});

test("a native session persists context but cannot restore Full access", async (t) => {
  const h = await providerHarness(t);
  await h.connection.send({ type: "session.configure", sessionId: "s", requestId: "config", changes: { model: "tech-lead", settings: { permissions: "full-access", modelScope: "pinned" } } });
  await prompt(h.connection);
  h.fake.event({ type: "timeline", provider: "claude", item: { type: "assistant_message", text: "Next, add XML." } });
  h.fake.event({ type: "turn_completed", provider: "claude" });
  const saved = h.events.filter((event) => event.type === "session.persistence").at(-1)!;
  assert.ok(!JSON.stringify(saved.persistence).includes("full-access"));
  await h.connection.send({ type: "session.close", sessionId: "s", requestId: "close" });
  const replayStart = h.events.length;
  await h.connection.send({ type: "session.open", sessionId: "s", requestId: "reopen", config, history: "replay", persistence: saved.persistence });
  assert.ok(h.events.slice(replayStart).some((event) => event.type === "timeline.item" && event.item.type === "assistant_message" && event.item.text === "Next, add XML."));
  await prompt(h.connection, "second", "Continue");
  assert.equal(h.fake.sends.length, 2);
  assert.equal(h.fake.creations[1].config.modeId, "auto");
  assert.match(h.fake.sends[1].text, /Next, add XML/);
  h.fake.event({ type: "turn_completed", provider: "claude" });
  await h.connection.send({ type: "session.configure", sessionId: "s", requestId: "explicit-access", changes: { settings: { permissions: "full-access" } } });
  await prompt(h.connection, "retry", "Continue");
  assert.equal(h.fake.creations[2].config.modeId, "bypassPermissions");
  assert.equal(h.codexStart.mock.callCount(), 0);
});

test("a provider with no mode catalog runs with its own defaults and receives planning instructions", async (t) => {
  const h = await providerHarness(t, false);
  h.settings.personas.find((item) => item.id === "tech-lead")!.provider = "grok";
  t.mock.method(h.fake.api.providers, "listModes", async () => ({ modes: [] }));
  await prompt(h.connection, "work");
  assert.equal(h.fake.creations[0].config.provider, "grok/vendor/model");
  assert.equal(h.fake.creations[0].config.modeId, undefined);
  assert.deepEqual(h.fake.creations[0].config.options, {});
  h.fake.event({ type: "turn_completed", provider: "grok" });
  await h.connection.send({ type: "session.configure", sessionId: "s", requestId: "plan", changes: { mode: "plan" } });
  await prompt(h.connection, "plan");
  assert.equal(h.fake.creations.length, 2);
  assert.equal(h.fake.creations[1].config.modeId, undefined);
  assert.match(h.fake.creations[1].config.systemPrompt ?? "", /without modifying workspace files/);
  assert.ok(h.events.some((event) => event.type === "timeline.item" && event.item.type === "notification" && /no dedicated planning mode/.test(event.item.message)));
  assert.equal(h.codexStart.mock.callCount(), 0);
});

test("interrupt stops the native turn and resolves its pending question", async (t) => {
  const h = await providerHarness(t);
  await prompt(h.connection);
  h.fake.event({ type: "permission_requested", provider: "claude", request: { id: "question", provider: "claude", kind: "question", name: "Question" } });
  assert.equal(h.fake.responses.length, 0);
  await h.connection.send({ type: "session.interrupt", sessionId: "s", requestId: "interrupt" });
  assert.equal(h.fake.archived, 1);
  assert.equal(h.events.filter((event) => event.type === "session.turn" && event.state === "canceled").length, 1);
  assert.ok(h.events.some((event) => event.type === "session.permission_resolved" && event.permissionId.endsWith(":question")));
});

test("a failed native Stop keeps receiving completion and lets the next prompt proceed", async (t) => {
  const h = await providerHarness(t);
  await prompt(h.connection);
  h.fake.failArchive(new Error("Host temporarily unavailable"));
  await h.connection.send({ type: "session.interrupt", sessionId: "s", requestId: "interrupt" });
  assert.ok(h.events.some((event) => event.type === "request.failed" && event.requestId === "interrupt"));
  assert.equal(h.fake.unsubscribed, 0);
  h.fake.failArchive(undefined);
  h.fake.event({ type: "timeline", provider: "claude", item: { type: "assistant_message", text: "Completed despite failed Stop." } });
  h.fake.event({ type: "turn_completed", provider: "claude" });
  assert.ok(h.events.some((event) => event.type === "session.turn" && event.state === "completed"));
  await prompt(h.connection, "after-failed-stop");
  assert.equal(h.fake.sends.length, 2);
  assert.match(h.fake.sends[1].text, /Completed despite failed Stop/);
});

test("native completion during a pending Stop is delivered exactly once", async (t) => {
  const h = await providerHarness(t);
  await prompt(h.connection);
  let release!: () => void;
  h.fake.gateArchive(new Promise<void>((resolve) => { release = resolve; }));
  const stopping = h.connection.send({ type: "session.interrupt", sessionId: "s", requestId: "interrupt" });
  h.fake.event({ type: "turn_completed", provider: "claude" });
  try {
    assert.deepEqual(h.events.filter((event) => event.type === "session.turn").map((event) => event.state), ["started", "completed"]);
  } finally { release(); await stopping; }
  assert.equal(h.fake.archived, 1);
  assert.equal(h.fake.unsubscribed, 1);
});

test("switching from native execution back to Codex sends the conversation handoff", async (t) => {
  const h = await providerHarness(t);
  await prompt(h.connection);
  h.fake.event({ type: "timeline", provider: "claude", item: { type: "assistant_message", text: "Preserve the CSV contract." } });
  h.fake.event({ type: "turn_completed", provider: "claude" });
  let notify: (event: CodexNotification) => void = () => {};
  t.mock.method(CodexAppServer.prototype, "onNotification", (listener: typeof notify) => { notify = listener; return () => {}; });
  const calls: Array<{ method: string; params: unknown }> = [];
  t.mock.method(CodexAppServer.prototype, "request", async (method: string, params: unknown) => {
    calls.push({ method, params });
    if (method === "thread/start") return { thread: { id: "codex-thread" } };
    return { turn: { id: "codex-turn" } };
  });
  await h.connection.send({ type: "session.configure", sessionId: "s", requestId: "persona", changes: { model: "writer" } });
  await prompt(h.connection, "second", "Continue with the next change");
  assert.match(JSON.stringify(calls.find((call) => call.method === "turn/start")?.params), /Preserve the CSV contract/);
  notify({ method: "turn/completed", params: { threadId: "codex-thread", turn: { id: "codex-turn", status: "completed" } } });
});

test("invalid intent and manually selected disabled or removed personas never launch a provider", async (t) => {
  const h = await providerHarness(t);
  h.classify(answers({ intent: { type: "choice", choice: "invalid", confidence: 1, probabilities: { invalid: 1 } } }));
  await prompt(h.connection);
  assert.equal(h.fake.creations.length, 0);
  h.classify(answers());
  await h.connection.send({ type: "session.configure", sessionId: "s", requestId: "persona", changes: { model: "tech-lead" } });
  h.settings.personas.find((item) => item.id === "tech-lead")!.enabled = false;
  await prompt(h.connection, "second");
  assert.equal(h.fake.creations.length, 0);
  h.settings.personas = h.settings.personas.filter((item) => item.id !== "tech-lead");
  await prompt(h.connection, "third");
  assert.equal(h.fake.creations.length, 0);
  assert.equal(h.codexStart.mock.callCount(), 0);
});
