import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test, type TestContext } from "node:test";
import type { ProviderEvent, ProviderConfigChanges, ProviderPrompt } from "@getpaseo/plugin/server/provider";
import { CodexAppServer, type CodexNotification, type CodexServerRequest } from "../server/codex-app-server";
import { createAutoModeProvider } from "../server/provider";
import { appendContext, readContext, type ContextEntry } from "../server/route-context";
import { evaluateRoute } from "../server/jev";
import { pickIntent, type RouteAnswers } from "../server/classifier";
import { LayaClassifier, disposeLaya } from "../server/laya";
import { defaults } from "../shared/settings";
import { answers, wireAnswers } from "./fixtures";
import * as workspaceState from "../server/workspace-state";

const choice = (value: string) => ({ type: "choice" as const, choice: value, probabilities: { [value]: 1 }, confidence: 1 });

async function harness(t: TestContext) {
  t.mock.method(workspaceState, "readWorkspaceState", async () => ({ status: "unavailable" as const }));
  const settings = { ...defaults, apiKey: "test-key", personas: defaults.personas.map((persona) => ({ ...persona })) };
  t.mock.method(fs, "readFile", async () => JSON.stringify(settings));
  let result: RouteAnswers = answers();
  const states: Record<string, unknown>[] = [];
  let classificationGate: Promise<void> | undefined;
  t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof fetch>) => {
    states.push(JSON.parse(String(init?.body)).state);
    await classificationGate;
    return Response.json({ answers: wireAnswers(result, settings.personas) });
  });
  let notify: (event: CodexNotification) => void = () => {};
  let request: (event: CodexServerRequest) => Promise<unknown> = async () => {};
  const calls: { method: string; params: Record<string, any> }[] = [];
  let turn = 0;
  let failStart = false;
  t.mock.method(CodexAppServer.prototype, "start", async () => {});
  t.mock.method(CodexAppServer.prototype, "close", async () => {});
  t.mock.method(CodexAppServer.prototype, "onNotification", (listener: typeof notify) => { notify = listener; return () => {}; });
  t.mock.method(CodexAppServer.prototype, "handleServerRequests", (handler: typeof request) => { request = handler; });
  t.mock.method(CodexAppServer.prototype, "request", async (method: string, params: Record<string, any> = {}) => {
    calls.push({ method, params });
    if (method === "thread/start" || method === "thread/resume") return { thread: { id: "thread" } };
    if (method === "thread/read") return { thread: { id: "thread", turns: [{ id: "old", items: [
      { type: "userMessage", id: "old-user", content: [{ type: "text", text: "Planeje a exportação CSV" }] },
      { type: "agentMessage", id: "old-answer", text: "Vou adicionar o exportador e os testes." },
    ] }] } };
    if (method === "turn/start") {
      if (failStart) throw new Error("Model unavailable");
      return { turn: { id: "turn-" + ++turn } };
    }
    if (method === "turn/steer") return { turnId: "turn-" + turn };
    return {};
  });
  const connection = await createAutoModeProvider().connect({
    versions: [1], capabilities: ["prompt.message", "prompt.steer", "permission", "session.persistence", "session.configure"],
  });
  t.after(() => connection.close());
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  const config = { cwd: process.cwd(), env: {}, mcpServers: {}, settings: {}, persist: true };
  await connection.send({ type: "session.open", sessionId: "s", requestId: "open", history: "skip", config });
  let message = 0;
  return {
    connection, calls, states, events, config, settings,
    setResult(value: RouteAnswers) { result = value; },
    gate(value: Promise<void> | undefined) { classificationGate = value; },
    fail(value: boolean) { failStart = value; },
    async configure(changes: ProviderConfigChanges) { await connection.send({ type: "session.configure", sessionId: "s", requestId: "configure", changes }); },
    async send(text: string, delivery: ProviderPrompt["delivery"] = "auto") {
      await connection.send({ type: "session.prompt", sessionId: "s", prompt: {
        clientMessageId: "message-" + ++message, delivery, input: { type: "message", content: [{ type: "text", text }] },
      } });
    },
    complete(status = "completed") { notify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn-" + turn, status } } }); },
    item(item: Record<string, unknown>) { notify({ method: "item/completed", params: { threadId: "thread", item } }); },
    request(event: CodexServerRequest) { return request(event); },
    latest() { return calls.filter((call) => call.method === "turn/start").at(-1)!.params; },
  };
}

test("bounded routing context clips text, removes unsupported roles and updates entries without reordering", () => {
  let context: ContextEntry[] = [];
  for (let i = 0; i < 10; i++) context = appendContext(context, { id: String(i), role: "user", text: "x".repeat(1500) + "END" });
  assert.equal(context.length, 6);
  assert.ok(context.every((item) => item.text.length <= 1000 && item.text.endsWith("END")));
  context = appendContext(context, { id: "4", role: "user", text: "Updated" });
  assert.equal(context[0].text, "Updated");
  assert.equal(context.length, 6);
  assert.deepEqual(readContext([{ id: "secret", role: "reasoning", text: "hidden" }, null]), []);
});

test("invalid intentions and scores fail closed", async (t) => {
  assert.throws(() => pickIntent(answers({ intent: choice("unknown") })), /unknown intent/);
  t.mock.method(globalThis, "fetch", async () => Response.json({ answers: wireAnswers(answers({ intent: { ...choice("implement"), confidence: 2 } })) }));
  await assert.rejects(evaluateRoute({ apiKey: "key", model: "jev", prompt: "Fix it" }), /not a choice/);
});

test("auto controls default off, activate by Jev decision, and reset on a following turn", async (t) => {
  const h = await harness(t);
  await h.send("Corrija o typo");
  assert.equal(h.latest().serviceTier, "default");
  assert.equal(h.latest().collaborationMode.mode, "default");
  assert.equal(h.latest().approvalPolicy, "on-request");
  assert.equal(h.latest().approvalsReviewer, "auto_review");
  assert.equal(h.latest().sandboxPolicy.type, "workspaceWrite");
  assert.equal(h.calls.find((call) => call.method === "thread/start")?.params.sandbox, "read-only");
  h.complete();
  h.setResult(answers({ plan: choice("on"), fast: choice("on"), intent: choice("discuss") }));
  await h.send("É urgente: planeje a exportação CSV");
  assert.equal(h.latest().serviceTier, "fast");
  assert.equal(h.latest().collaborationMode.mode, "plan");
  assert.equal(h.latest().sandboxPolicy.type, "readOnly");
  h.item({ id: "plan-answer", type: "agentMessage", text: "Vou adicionar o exportador e os testes." });
  h.item({ id: "private", type: "reasoning", summary: ["do not send"] });
  h.complete();
  h.setResult(answers());
  await h.send("Pode implementar");
  assert.equal(h.latest().collaborationMode.mode, "default");
  assert.equal(h.latest().serviceTier, "default");
  assert.equal(h.latest().sandboxPolicy.type, "workspaceWrite");
  const context = h.states.at(-1)!.recentConversation as { role: string; text: string }[];
  assert.ok(context.some((entry) => entry.role === "assistant" && entry.text.includes("exportador")));
  assert.ok(context.every((entry) => !entry.text.includes("do not send")));
});

test("manual model, speed, plan and permissions override routing without leaking into later turns", async (t) => {
  const h = await harness(t);
  h.setResult(answers({ plan: choice("on"), fast: choice("on") }));
  await h.configure({ model: defaults.autoCodexModelCheap, mode: "default", settings: { fast: "off" } });
  await h.send("Implemente a mudança");
  assert.equal(h.latest().model, defaults.autoCodexModelCheap);
  assert.equal(h.latest().collaborationMode.settings.model, defaults.autoCodexModelCheap);
  assert.equal(h.latest().collaborationMode.mode, "default");
  assert.equal(h.latest().serviceTier, "default");
  h.complete();
  await h.send("Continue");
  assert.equal(h.latest().model, defaults.autoCodexModelLead);
  h.complete();
  await h.configure({ settings: { permissions: "full-access" } });
  await h.send("Faça a alteração autorizada");
  assert.equal(h.latest().sandboxPolicy.type, "dangerFullAccess");
  assert.equal(h.latest().approvalPolicy, "never");
  h.complete();
  await h.configure({ mode: "plan" });
  await h.send("Agora planeje");
  assert.equal(h.latest().sandboxPolicy.type, "readOnly");
  assert.equal(h.latest().approvalPolicy, "on-request");
  h.complete();
  await h.configure({ mode: "default", settings: { permissions: "auto-review" } });
  await h.send("Implemente");
  assert.equal(h.latest().sandboxPolicy.type, "workspaceWrite");
  assert.equal(h.latest().approvalPolicy, "on-request");
  const saved = h.events.filter((event) => event.type === "session.persistence").at(-1)!;
  assert.ok(!JSON.stringify(saved.persistence).includes("full-access"));
});

test("Codex persona work mode changes the approval reviewer and preserves intent and Plan boundaries", async (t) => {
  const h = await harness(t);
  const persona = h.settings.personas.find((item) => item.id === "tech-lead")!;
  await h.configure({ model: persona.id, settings: { modelScope: "pinned" } });
  for (const workMode of ["", "auto", "auto-review", "auto"]) {
    persona.workMode = workMode;
    await h.send("Implement the change");
    assert.equal(h.latest().approvalsReviewer, workMode === "auto" ? "user" : "auto_review");
    assert.equal(h.latest().approvalPolicy, "on-request");
    assert.equal(h.latest().sandboxPolicy.type, "workspaceWrite");
    h.complete();
  }
  h.setResult(answers({ intent: choice("review") }));
  await h.send("Review the change");
  assert.equal(h.latest().sandboxPolicy.type, "readOnly");
  assert.equal(h.latest().approvalsReviewer, "user");
  h.complete();
  await h.configure({ settings: { permissions: "full-access" }, mode: "plan" });
  await h.send("Plan the next change");
  assert.equal(h.latest().sandboxPolicy.type, "readOnly");
  assert.equal(h.latest().approvalPolicy, "on-request");
  assert.equal(h.latest().collaborationMode.mode, "plan");
});

test("Auto uses Writer for prose and Tech Lead for code delivery", async (t) => {
  const h = await harness(t);
  h.setResult(answers({ taskType: choice("write"), personaScores: { writer: 1 }, effort: choice("medium") }));
  await h.send("Rewrite the installation guide for beginners");
  assert.equal(h.latest().model, "gpt-5.6-terra");
  assert.equal(h.latest().effort, "medium");

  h.complete();
  h.setResult(answers({ personaScores: { "tech-lead": 1 }, effort: choice("high") }));
  await h.send("Refactor the cross-service authentication flow");
  assert.equal(h.latest().model, "gpt-5.6-sol");
  assert.equal(h.latest().effort, "high");
});

test("failed classification never starts Codex and failed starts preserve one-shot selections", async (t) => {
  const h = await harness(t);
  await h.configure({ model: defaults.autoCodexModelCheap });
  h.setResult(answers({ intent: choice("invalid") }));
  await h.send("Corrija");
  assert.equal(h.calls.length, 0);
  h.setResult(answers());
  h.fail(true);
  await h.send("Tente de novo");
  assert.ok(!h.events.some((event) => event.type === "timeline.item" && event.item.type === "notification" && event.item.id.startsWith("auto-route:")));
  h.fail(false);
  await h.send("Tente novamente");
  assert.equal(h.latest().model, defaults.autoCodexModelCheap);
  assert.equal(h.states.at(-1)!.recentConversation, undefined);
  const notices = h.events.flatMap((event) => event.type === "timeline.item" && event.item.type === "notification" && event.item.id.startsWith("auto-route:") ? [event.item.message] : []);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /Selected: Reporter/);
  assert.match(notices[0], /Mode: Auto-review/);
});

test("pinned selections survive reopening, but provider persistence cannot grant full access", async (t) => {
  const h = await harness(t);
  await h.configure({ model: defaults.autoCodexModelCheap, settings: { modelScope: "pinned", permissions: "full-access" } });
  await h.send("Implemente");
  h.item({ type: "agentMessage", id: "answer", text: "Pronto, agora podemos revisar." });
  h.complete();
  await h.send("Continue");
  assert.equal(h.latest().model, defaults.autoCodexModelCheap);
  h.complete();
  const saved = h.events.filter((event) => event.type === "session.persistence").at(-1)!;
  await h.connection.send({ type: "session.close", sessionId: "s", requestId: "close" });
  await h.connection.send({ type: "session.open", sessionId: "s", requestId: "reopen", history: "skip", config: h.config, persistence: saved.persistence });
  await h.send("Revise");
  assert.equal(h.latest().model, defaults.autoCodexModelCheap);
  assert.equal(h.latest().approvalPolicy, "on-request");
  assert.notEqual(h.latest().sandboxPolicy.type, "dangerFullAccess");
  assert.ok((h.states.at(-1)!.recentConversation as unknown[]).length > 0);
});

test("legacy sessions hydrate context even when timeline replay is skipped", async (t) => {
  const h = await harness(t);
  await h.connection.send({ type: "session.close", sessionId: "s", requestId: "close" });
  await h.connection.send({ type: "session.open", sessionId: "s", requestId: "reopen", history: "skip", config: h.config, persistence: { version: 1, data: { threadId: "thread" } } });
  await h.send("Pode implementar");
  assert.ok(JSON.stringify(h.states.at(-1)).includes("exportador"));
  assert.equal(h.events.some((event) => event.type === "timeline.item" && event.item.id === "old-answer"), false);
});

test("parallel prompts cannot race classification and steering preserves current controls", async (t) => {
  const h = await harness(t);
  let release!: () => void;
  h.gate(new Promise<void>((resolve) => { release = resolve; }));
  const pending = h.send("Implemente");
  await h.send("Outra mensagem");
  release();
  await pending;
  assert.equal(h.states.length, 1);
  assert.equal(h.calls.filter((call) => call.method === "turn/start").length, 1);
  await h.configure({ mode: "plan", settings: { fast: "on" } });
  await h.send("Foque nos testes", "steer");
  assert.equal(h.states.length, 1);
  assert.equal(h.calls.at(-1)!.method, "turn/steer");
  assert.equal(h.latest().serviceTier, "default");
  h.complete();
  h.gate(undefined);
  await h.send("Próxima tarefa");
  assert.equal(h.latest().serviceTier, "fast");
  assert.equal(h.latest().collaborationMode.mode, "plan");
});

test("Stop during workspace assessment prevents classification and provider startup", async (t) => {
  const h = await harness(t);
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  t.mock.method(workspaceState, "readWorkspaceState", async () => {
    started(); await gate; return { status: "unavailable" as const };
  });
  const pending = h.send("Implement the change");
  await ready;
  await h.connection.send({ type: "session.interrupt", sessionId: "s", requestId: "stop" });
  release();
  await pending;
  assert.equal(h.states.length, 0);
  assert.equal(h.calls.length, 0);
  await h.send("Try again");
  assert.equal(h.calls.filter((call) => call.method === "turn/start").length, 1);
});

test("Plan questions forward the actual selection and allow skipping without inventing an answer", async (t) => {
  const h = await harness(t);
  await h.send("Planeje");
  const result = h.request({ id: 9, method: "item/tool/requestUserInput", params: {
    questions: [
      { id: "format", header: "Formato", question: "Qual formato?", options: [{ label: "CSV", description: "Arquivo de texto" }, { label: "JSON", description: "Dados estruturados" }] },
      { id: "extra", header: "Extra", question: "Algo mais?", options: [] },
    ],
  } });
  const permission = h.events.filter((event) => event.type === "session.permission").at(-1)!;
  assert.equal(permission.request.id, "codex:9");
  assert.equal((permission.request.input?.questions as unknown[]).length, 2);
  await h.connection.send({ type: "session.permission", sessionId: "s", permissionId: "codex:9", response: { behavior: "allow", updatedInput: { answers: { Formato: "JSON", Extra: "" } } } });
  assert.deepEqual(await result, { answers: { format: { answers: ["JSON"] }, extra: { answers: [] } } });
});

test("interrupt during classification prevents startup, and question responses work synchronously", async (t) => {
  const h = await harness(t);
  let release!: () => void;
  h.gate(new Promise<void>((resolve) => { release = resolve; }));
  const pending = h.send("Implement the change");
  await h.connection.send({ type: "session.interrupt", sessionId: "s", requestId: "stop" });
  release();
  await pending;
  assert.equal(h.calls.length, 0);
  h.gate(undefined);
  await h.send("Try again");
  const respond = h.connection.onEvent((event) => {
    if (event.type === "session.permission") void h.connection.send({ type: "session.permission", sessionId: "s", permissionId: event.request.id,
      response: { behavior: "allow", updatedInput: { answers: { First: "A", Second: "Free text", Third: "C" } } },
    });
  });
  const result = await h.request({ id: 42, method: "tool/requestUserInput", params: { questions: [
    { id: "a", header: "First", question: "First?" }, { id: "b", header: "Second", question: "Second?" }, { id: "c", header: "Third", question: "Third?" },
  ] } });
  respond();
  assert.deepEqual(result, { answers: { a: { answers: ["A"] }, b: { answers: ["Free text"] }, c: { answers: ["C"] } } });
});

test("interrupt while Codex start is pending stops the returned turn and permits another prompt", async (t) => {
  const h = await harness(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const original = CodexAppServer.prototype.request;
  t.mock.method(CodexAppServer.prototype, "request", async function (this: CodexAppServer, method: string, params: unknown) {
    const result = await original.call(this, method, params);
    if (method === "turn/start") await gate;
    if (method === "turn/interrupt") h.complete("interrupted");
    return result;
  });
  const pending = h.send("Implement the change");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.filter((call) => call.method === "turn/start").length, 1);
  await h.connection.send({ type: "session.interrupt", sessionId: "s", requestId: "stop" });
  release();
  await pending;
  assert.deepEqual(h.calls.find((call) => call.method === "turn/interrupt")?.params, { threadId: "thread", turnId: "turn-1" });
  assert.deepEqual(h.events.filter((event) => event.type === "session.turn").map((event) => event.state), ["started", "canceled"]);
  await h.send("Try again");
  assert.equal(h.calls.filter((call) => call.method === "turn/start").length, 2);
});

test("Codex completion arriving before its start reply is emitted after the turn starts", async (t) => {
  const h = await harness(t);
  await h.send("First turn");
  h.complete();
  const original = CodexAppServer.prototype.request;
  t.mock.method(CodexAppServer.prototype, "request", async function (this: CodexAppServer, method: string, params: unknown) {
    const result = await original.call(this, method, params);
    if (method === "turn/start") h.complete();
    return result;
  });
  const start = h.events.length;
  await h.send("Second turn");
  assert.deepEqual(h.events.slice(start).filter((event) => event.type === "session.turn").map((event) => event.state), ["started", "completed"]);
});


test("Laya shares permission boundaries and never restores Full access", async (t) => {
  const h = await harness(t);
  t.mock.method(fs, "readFile", async () => JSON.stringify({ ...defaults, classifier: "laya" }));
  let result: RouteAnswers = answers();
  t.mock.method(LayaClassifier.prototype, "evaluate", async () => result);
  t.after(disposeLaya);
  for (const intent of ["discuss", "review", "implement"] as const) {
    result = answers({ intent: choice(intent) });
    await h.send("A request");
    assert.equal(h.latest().sandboxPolicy.type, intent === "implement" ? "workspaceWrite" : "readOnly");
    assert.equal(h.latest().approvalsReviewer, "auto_review");
    h.complete();
  }
  await h.configure({ settings: { permissions: "full-access" }, mode: "plan" });
  await h.send("Plan this");
  assert.equal(h.latest().sandboxPolicy.type, "readOnly");
  assert.equal(h.states.length, 0);
});


test("new provider migrates an old Auto model ID and keeps safe thread persistence", async (t) => {
  const h = await harness(t);
  assert.equal(createAutoModeProvider().id, "auto-mode-for-paseo");
  await h.connection.send({ type: "session.close", sessionId: "s", requestId: "close" });
  await h.connection.send({ type: "session.open", sessionId: "s", requestId: "reopen", history: "skip", config: h.config, persistence: {
    version: 1, data: { threadId: "thread", selectedModel: "auto-jev-codex-for-paseo", controls: { permissions: "full-access", modelScope: "pinned" } },
  } });
  const config = h.events.filter((event) => event.type === "session.config").at(-1)!;
  assert.equal(config.config.model, "auto-mode-for-paseo");
  await h.send("Implement this");
  assert.equal(h.latest().threadId, "thread");
  assert.equal(h.latest().sandboxPolicy.type, "workspaceWrite");
  assert.equal(h.latest().approvalPolicy, "on-request");
});

test("a Laya failure never starts a Codex turn or calls TypeSafe", async (t) => {
  const h = await harness(t);
  t.mock.method(fs, "readFile", async () => JSON.stringify({ ...defaults, classifier: "laya", apiKey: "test-key" }));
  t.mock.method(LayaClassifier.prototype, "evaluate", async () => { throw new Error("Laya unavailable"); });
  t.after(disposeLaya);
  await h.send("Implement this");
  assert.equal(h.calls.some((call) => call.method === "turn/start"), false);
  assert.equal(h.states.length, 0);
  assert.ok(JSON.stringify(h.events).includes("Laya unavailable"));
});

for (const classifier of ["jev", "laya"] as const) {
  test(`${classifier} uses workspace-informed depth despite a higher shallow scope score`, async (t) => {
    const h = await harness(t);
    h.settings.classifier = classifier;
    // Two review owners: a Standard-depth setup with the best scope fit and the Expert Critic.
    Object.assign(h.settings.personas.find((persona) => persona.id === "reporter")!, { effort: "high", taskTypes: ["review"], taskTypesAuto: false });
    let workspace: workspaceState.WorkspaceState = { status: "available", basis: "uncommitted", files: 1, added: 1, removed: 0, binary: 0, untracked: 0, capped: false };
    t.mock.method(workspaceState, "readWorkspaceState", async (cwd: string) => {
      assert.equal(cwd, h.config.cwd);
      return workspace;
    });
    const classify = (state: Record<string, unknown>) => {
      assert.deepEqual(state.workspace, workspace);
      assert.equal(state.request, "are the changes here good ?");
      return answers({ intent: choice("review"), effort: choice(workspace.status === "available" && workspace.files > 1 ? "high" : "low"),
        personaScores: { reporter: 0.98, critic: 0.85, staff: 0.2, writer: 0.15, "tech-lead": 0.1 } });
    };
    if (classifier === "jev") t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof fetch>) => {
      return Response.json({ answers: wireAnswers(classify(JSON.parse(String(init?.body)).state), h.settings.personas) });
    });
    else {
      t.mock.method(LayaClassifier.prototype, "evaluate", async (input: Parameters<LayaClassifier["evaluate"]>[0]) => classify({ request: input.prompt, workspace: input.workspace }));
      t.after(disposeLaya);
    }
    await h.send("are the changes here good ?");
    assert.equal(h.latest().model, defaults.personas.find((persona) => persona.id === "reporter")!.model);
    h.complete();
    workspace = { ...workspace, files: 41, added: 2300, removed: 418 };
    await h.send("are the changes here good ?");
    assert.equal(h.latest().model, defaults.personas.find((persona) => persona.id === "critic")!.model);
    assert.equal(h.latest().sandboxPolicy.type, "readOnly");
    assert.equal(h.latest().collaborationMode.mode, "default");
    const notifications = h.events.filter((event) => event.type === "timeline.item" && event.item.type === "notification");
    assert.equal(notifications.length, 2, "Each started turn must have one summary.");
    const latest = notifications.at(-1)!;
    assert.ok(latest.type === "timeline.item" && latest.item.type === "notification" && /Auto: Critic.*Type: Review.*Depth: Deep/.test(latest.item.message));
  });

  test(`${classifier} starts a read-only turn for a generic message with low persona fit`, async (t) => {
    const h = await harness(t);
    t.mock.method(fs, "readFile", async () => JSON.stringify({ ...defaults, classifier, apiKey: "test-key", thresholdPersona: 0.9 }));
    const result = answers({ intent: choice("discuss"), taskType: choice("other"), personaScores: {
      critic: 0.01, reporter: 0.03, staff: 0.01, "tech-lead": 0.04, writer: 0.08,
    } });
    h.setResult(result);
    if (classifier === "laya") {
      t.mock.method(LayaClassifier.prototype, "evaluate", async () => result);
      t.after(disposeLaya);
    }
    await h.send("testing");
    const starts = h.calls.filter((call) => call.method === "turn/start");
    assert.equal(starts.length, 1, "Low fit must still start a provider turn.");
    assert.equal(h.latest().model, defaults.personas.find((persona) => persona.id === "writer")!.model);
    assert.equal(h.latest().sandboxPolicy.type, "readOnly");
    assert.equal(h.latest().collaborationMode.mode, "default");
    assert.equal(h.latest().approvalPolicy, "on-request");
    if (classifier === "laya") assert.equal(h.states.length, 0);
  });

  test(`${classifier} selects semantic roles without changing access boundaries`, async (t) => {
    const h = await harness(t);
    t.mock.method(fs, "readFile", async () => JSON.stringify({ ...defaults, classifier, apiKey: "test-key" }));
    let result = answers();
    if (classifier === "laya") {
      t.mock.method(LayaClassifier.prototype, "evaluate", async () => result);
      t.after(disposeLaya);
    }
    const cases = [
      ["discuss", "cheap", "low", "Which output format is configured?", "gpt-5.6-luna"],
      ["discuss", "standard", "medium", "Explain how this validation works", "gpt-5.6-terra"],
      ["discuss", "lead", "high", "Investigate this race across components", "gpt-5.6-sol"],
      ["discuss", "staff", "xhigh", "Design cross-region consistency under conflicting constraints", "gpt-6-astra"],
      ["review", "review", "medium", "Review this validation rule", defaults.personas.find((persona) => persona.id === "critic")!.model],
      ["review", "review", "high", "Review error recovery across these components", defaults.personas.find((persona) => persona.id === "critic")!.model],
      ["review", "review", "xhigh", "Audit tenant isolation across services", "gpt-6-astra"],
      ["implement", "lead", "high", "Rename this local variable", "gpt-5.6-sol"],
      ["implement", "standard", "medium", "Rewrite the validation guide", "gpt-5.6-terra"],
      ["implement", "lead", "high", "Implement recovery across components", "gpt-5.6-sol"],
    ] as const;
    for (const [intent, lane, effort, prompt, model] of cases) {
      const persona = ({ cheap: "reporter", standard: "writer", lead: "tech-lead", staff: "staff", review: "critic" } as const)[lane];
      const taskType = ({ reporter: "report", writer: "write", "tech-lead": "implement", staff: "design", critic: "review" } as const)[persona];
      result = answers({ intent: choice(intent), taskType: choice(taskType), personaScores: { [persona]: 1 }, effort: choice(effort) });
      h.setResult(result);
      await h.send(prompt);
      assert.equal(h.latest().model, model, prompt);
      assert.equal(h.latest().effort, intent === "review" ? defaults.personas.find((persona) => persona.id === "critic")!.effort : effort);
      assert.equal(h.latest().sandboxPolicy.type, intent === "implement" ? "workspaceWrite" : "readOnly", prompt);
      assert.equal(h.latest().approvalPolicy, "on-request");
      assert.equal(h.latest().approvalsReviewer, "auto_review");
      h.complete();
    }
    if (classifier === "laya") assert.equal(h.states.length, 0);
  });
}
