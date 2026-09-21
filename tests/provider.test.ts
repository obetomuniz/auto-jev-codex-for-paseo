import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";
import type { ProviderEvent, ProviderPrompt } from "@getpaseo/plugin/server/provider";
import { CodexAppServer, type CodexNotification, type CodexServerRequest } from "../server/codex-app-server";
import { createAutoJevCodexProvider } from "../server/provider";
import { defaults } from "../shared/settings";
import { answers } from "./fixtures";

test("provider routes new turns in one thread and preserves steer, permissions, interruption, and restoration", async (t) => {
  const settings = {
    ...defaults,
    apiKey: "test-key",
    autoCodexModelCheap: "mechanical-model",
    autoCodexModelReview: "review-model",
    autoCodexEffortCheap: "low",
    autoCodexEffortReview: "high",
  };
  t.mock.method(fs, "readFile", async () => JSON.stringify(settings));
  let classifications = 0;
  t.mock.method(globalThis, "fetch", async () => {
    classifications += 1;
    return Response.json({ answers: answers(classifications === 1
      ? {
          effort: { type: "choice", choice: "low", probabilities: { low: 1 }, confidence: 1 },
          mechanical_local: { type: "noul", noul: 1 },
        }
      : {
          intent: { type: "choice", choice: "review", probabilities: { review: 1 }, confidence: 1 },
          independent_review: { type: "noul", noul: 1 },
        }) });
  });

  let notify: (event: CodexNotification) => void = () => assert.fail("Codex listener not registered");
  let permission: (request: CodexServerRequest) => Promise<unknown> = async () => assert.fail("Permission handler not registered");
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let turnNumber = 0;
  t.mock.method(CodexAppServer.prototype, "start", async () => {});
  t.mock.method(CodexAppServer.prototype, "close", async () => {});
  t.mock.method(CodexAppServer.prototype, "onNotification", (listener: (event: CodexNotification) => void) => {
    notify = listener;
    return () => {};
  });
  t.mock.method(CodexAppServer.prototype, "handleServerRequests", (handler: (request: CodexServerRequest) => Promise<unknown>) => { permission = handler; });
  t.mock.method(CodexAppServer.prototype, "request", async <T>(method: string, params?: unknown): Promise<T> => {
    calls.push({ method, params: (params ?? {}) as Record<string, unknown> });
    if (method === "thread/start" || method === "thread/resume") return { thread: { id: "thread-1" } } as T;
    if (method === "thread/read") {
      return {
        thread: {
          id: "thread-1",
          turns: [{
            id: "restored-turn",
            items: [
              { type: "userMessage", id: "restored-user", clientId: "restored-client", content: [{ type: "text", text: "Earlier question" }] },
              { type: "agentMessage", id: "restored-assistant", text: "Earlier answer" },
              { type: "commandExecution", id: "restored-command", command: "npm test", status: "completed", exitCode: 0 },
            ],
          }],
        },
      } as T;
    }
    if (method === "turn/start") return { turn: { id: `turn-${++turnNumber}` } } as T;
    if (method === "turn/steer") return { turnId: `turn-${turnNumber}` } as T;
    if (method === "turn/interrupt") return {} as T;
    throw new Error(`Unexpected Codex request: ${method}`);
  });

  const connection = await createAutoJevCodexProvider().connect({
    versions: [1], capabilities: ["prompt.message", "prompt.steer", "permission", "session.persistence"],
  });
  t.after(() => connection.close());
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  const config = { cwd: process.cwd(), env: {}, mcpServers: {}, settings: {}, persist: true };
  await connection.send({ type: "session.open", requestId: "open", sessionId: "session-1", history: "skip", config });
  async function sendText(id: string, text: string, delivery: ProviderPrompt["delivery"] = "auto") {
    await connection.send({
      type: "session.prompt", sessionId: "session-1",
      prompt: { clientMessageId: id, delivery, input: { type: "message", content: [{ type: "text", text }] } },
    });
  }

  await sendText("message-1", "Fix the typo");
  assert.equal(classifications, 1);
  assert.equal(calls.at(-1)?.params.model, "mechanical-model");
  assert.equal(calls.at(-1)?.params.effort, "low");
  assert.deepEqual(calls.at(-1)?.params.sandboxPolicy, {
    type: "workspaceWrite",
    writableRoots: [config.cwd],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  });
  notify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });

  await sendText("message-2", "Review the change");
  assert.equal(classifications, 2);
  assert.equal(calls.at(-1)?.params.model, "review-model");
  assert.equal(calls.at(-1)?.params.effort, "high");
  assert.deepEqual(calls.at(-1)?.params.sandboxPolicy, { type: "readOnly", networkAccess: true });
  const turns = calls.filter((call) => call.method === "turn/start");
  assert.deepEqual(turns.map((call) => call.params.threadId), ["thread-1", "thread-1"]);
  assert.equal(calls.filter((call) => call.method === "thread/start").length, 1);

  await sendText("message-3", "Focus on error handling", "steer");
  assert.equal(classifications, 2);
  assert.equal(calls.at(-1)?.method, "turn/steer");
  assert.equal(calls.at(-1)?.params.expectedTurnId, "turn-2");
  assert.ok(events.some((event) => event.type === "session.prompt_result" && event.result.type === "steer"));

  const approval = permission({ id: 7, method: "item/commandExecution/requestApproval", params: { command: "npm test" } });
  assert.ok(events.some((event) => event.type === "session.permission"));
  await connection.send({ type: "session.permission", sessionId: "session-1", permissionId: "codex:7", response: { behavior: "deny" } });
  assert.deepEqual(await approval, { decision: "decline" });

  await connection.send({ type: "session.interrupt", sessionId: "session-1", requestId: "stop" });
  assert.deepEqual(calls.at(-1), { method: "turn/interrupt", params: { threadId: "thread-1", turnId: "turn-2" } });
  await connection.send({ type: "session.close", sessionId: "session-1", requestId: "close" });

  const saved = events.find((event) => event.type === "session.persistence");
  assert.ok(saved && saved.type === "session.persistence");
  const eventsBeforeRestore = events.length;
  await connection.send({ type: "session.open", sessionId: "session-1", requestId: "reopen", config, history: "replay", persistence: saved.persistence });
  const restored = events.slice(eventsBeforeRestore).filter((event) => event.type === "timeline.item");
  assert.ok(restored.some((event) => event.item.type === "user_message" && event.item.text === "Earlier question"));
  assert.ok(restored.some((event) => event.item.type === "assistant_message" && event.item.text === "Earlier answer"));
  assert.ok(restored.some((event) => event.item.type === "tool_call" && event.item.name === "command"));
  await sendText("message-4", "Continue reviewing");
  assert.equal(calls.filter((call) => call.method === "thread/start").length, 1);
  assert.equal(calls.find((call) => call.method === "thread/resume")?.params.threadId, "thread-1");
  assert.equal(events.some((event) => event.type === "session.prompt_result" && event.result.type === "failed"), false);
});

test("provider replays paginated Codex history", async (t) => {
  t.mock.method(CodexAppServer.prototype, "start", async () => {});
  t.mock.method(CodexAppServer.prototype, "close", async () => {});
  t.mock.method(CodexAppServer.prototype, "request", async <T>(method: string, params?: unknown): Promise<T> => {
    const request = (params ?? {}) as Record<string, unknown>;
    if (method === "thread/resume") return { thread: { id: "thread-paged" } } as T;
    if (method === "thread/read") return { thread: { id: "thread-paged", turns: [] } } as T;
    if (method === "thread/turns/list") {
      if (request.cursor === null) {
        return { data: [{ id: "turn-a", items: [] }], nextCursor: "next-turn" } as T;
      }
      return { data: [{ id: "turn-b", items: [] }], nextCursor: null } as T;
    }
    if (method === "thread/items/list") {
      if (request.turnId === "turn-a") {
        return {
          data: [{ turnId: "turn-a", item: { type: "userMessage", id: "paged-user", content: [{ type: "text", text: "First page" }] } }],
          nextCursor: null,
        } as T;
      }
      return {
        data: [{ turnId: "turn-b", item: { type: "agentMessage", id: "paged-assistant", text: "Second page" } }],
        nextCursor: null,
      } as T;
    }
    throw new Error(`Unexpected Codex request: ${method}`);
  });

  const connection = await createAutoJevCodexProvider().connect({
    versions: [1], capabilities: ["prompt.message", "session.persistence"],
  });
  t.after(() => connection.close());
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  await connection.send({
    type: "session.open",
    requestId: "open",
    sessionId: "session-paged",
    history: "replay",
    config: { cwd: process.cwd(), env: {}, mcpServers: {}, settings: {}, persist: true },
    persistence: { version: 1, data: { threadId: "thread-paged" } },
  });

  const restored = events.filter((event) => event.type === "timeline.item");
  assert.ok(restored.some((event) => event.item.type === "user_message" && event.item.text === "First page"));
  assert.ok(restored.some((event) => event.item.type === "assistant_message" && event.item.text === "Second page"));
});
