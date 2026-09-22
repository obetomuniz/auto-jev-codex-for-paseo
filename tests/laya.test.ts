import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { LayaClassifier, disposeLaya, LAYA_MAX_BYTES, LAYA_MAX_PENDING, LAYA_MAX_PROMPT_CHARS, LAYA_STARTUP_MS, LAYA_INFERENCE_MS } from "../server/laya";
import { classifyPrompt, routePrompt } from "../server/routing";
import { defaults } from "../shared/settings";
import { answers } from "./fixtures";

const input = { python: "python", cache: "C:/local-laya-cache", model: "multilingual" as const, device: "cpu" as const, prompt: "Corrija o erro" };
function fakeWorker(t: TestContext, options: { response?: unknown; raw?: string; startup?: string; hang?: boolean } = {}) {
  const requests: Record<string, any>[] = [];
  const children: Array<EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: Writable; kill(): boolean }> = [];
  const calls: Array<{ command: unknown; args: unknown; options: any }> = [];
  t.mock.method(childProcess, "spawn", (command: unknown, args: unknown, spawnOptions: unknown) => {
    calls.push({ command, args, options: spawnOptions });
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(),
      stdin: new Writable({ write(chunk, _encoding, done) {
        requests.push(JSON.parse(String(chunk)));
        if (!options.hang) queueMicrotask(() => child.stdout.write(options.raw ?? JSON.stringify(options.response ?? { answers: answers() }) + "\n"));
        done();
      } }),
      kill() { return true; },
    });
    t.mock.method(child, "kill");
    children.push(child);
    if (options.startup !== "hang") queueMicrotask(() => child.stdout.write(options.startup ?? '{"ready":true}\n'));
    return child;
  });
  return { calls, requests, children };
}

test("Laya reuses its process, bounds context and excludes credentials", async (t) => {
  const worker = fakeWorker(t);
  const client = new LayaClassifier(); t.after(() => client.close());
  const context = Array.from({ length: 9 }, (_, i) => ({ id: String(i), role: "user" as const, text: "x".repeat(1200) }));
  assert.deepEqual(await client.evaluate({ ...input, context }), answers());
  await client.evaluate(input);
  assert.equal(worker.calls.length, 1);
  assert.equal(worker.calls[0].options.shell, false);
  assert.equal(worker.calls[0].options.windowsHide, true);
  assert.equal(worker.calls[0].options.env.TYPESAFE_API_KEY, undefined);
  assert.equal(worker.calls[0].options.env.OPENAI_API_KEY, undefined);
  assert.equal(worker.calls[0].options.env.HF_HOME, input.cache);
  assert.equal(worker.calls[0].options.env.HF_HUB_DISABLE_SYMLINKS, "1");
  assert.deepEqual((worker.calls[0].args as string[]).slice(0, 2), ["-I", "-u"]);
  const history = worker.requests[0].state.recentConversation;
  assert.equal(history.length, 6);
  assert.ok(history.every((item: { text: string }) => item.text.length === 1000));
  assert.equal("id" in history[0], false);
  assert.equal("apiKey" in worker.requests[0], false);
  assert.equal(worker.requests[0].state.request, input.prompt);
});

test("Laya serializes requests and changes models only between requests", async (t) => {
  const worker = fakeWorker(t);
  const client = new LayaClassifier(); t.after(() => client.close());
  await Promise.all([client.evaluate(input), client.evaluate({ ...input, model: "english" })]);
  assert.equal(worker.calls.length, 2);
  assert.equal((worker.children[0].kill as any).mock.callCount(), 1);
});

test("Laya enforces prompt, byte and queue limits before inference", async (t) => {
  fakeWorker(t, { hang: true });
  const client = new LayaClassifier();
  await assert.rejects(client.evaluate({ ...input, prompt: "x".repeat(LAYA_MAX_PROMPT_CHARS + 1) }), /16,000/);
  await assert.rejects(client.evaluate({ ...input, prompt: "\u4e2d".repeat(LAYA_MAX_PROMPT_CHARS), context: Array.from({ length: 6 }, (_, i) => ({ id: String(i), role: "user", text: "\u4e2d".repeat(1000) })) }), /64 KiB/);
  const pending = Array.from({ length: LAYA_MAX_PENDING }, () => client.evaluate(input));
  const settled = Promise.allSettled(pending);
  await assert.rejects(client.evaluate(input), /busy/);
  client.close();
  assert.ok((await settled).every((result) => result.status === "rejected"));
});

for (const [label, raw, pattern] of [
  ["invalid JSON", "not json\n", /invalid JSON/],
  ["oversized response", "x".repeat(LAYA_MAX_BYTES + 1), /64 KiB/],
  ["missing intent", JSON.stringify({ answers: { ...answers(), intent: undefined } }) + "\n", /not a choice/],
  ["invalid score", JSON.stringify({ answers: answers({ mechanical_local: { type: "noul", noul: 2 } }) }) + "\n", /not a noul/],
  ["token overflow", '{"error":"context"}\n', /token budget/],
] as const) test("Laya rejects " + label, async (t) => {
  fakeWorker(t, { raw });
  const client = new LayaClassifier(); t.after(() => client.close());
  await assert.rejects(client.evaluate(input), pattern);
});

test("Laya startup failures never call TypeSafe even with a saved key", async (t) => {
  fakeWorker(t, { startup: '{"error":"startup"}\n' });
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not contact TypeSafe"); });
  t.after(disposeLaya);
  await assert.rejects(classifyPrompt("Fix it", [], { ...defaults, classifier: "laya", apiKey: "test-key" }), /could not load/);
  assert.equal(fetch.mock.callCount(), 0);
});

test("Jev alone requires a TypeSafe key; Laya works with none", async (t) => {
  const old = process.env.TYPESAFE_API_KEY; delete process.env.TYPESAFE_API_KEY;
  t.after(() => { if (old === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = old; disposeLaya(); });
  await assert.rejects(classifyPrompt("Fix it", [], defaults), /TypeSafe key/);
  fakeWorker(t);
  assert.deepEqual(await classifyPrompt("Fix it", [], { ...defaults, classifier: "laya" }), answers());
});

test("unknown Laya intent stops routing", async (t) => {
  fakeWorker(t, { response: { answers: answers({ intent: { type: "choice", choice: "unknown", confidence: 1, probabilities: { unknown: 1 } } }) } });
  t.mock.method(fs, "readFile", async () => JSON.stringify({ ...defaults, classifier: "laya" }));
  t.after(disposeLaya);
  await assert.rejects(routePrompt("Fix it"), /unknown intent/);
});

for (const phase of ["startup", "inference"] as const) test("Laya bounds " + phase + " time and kills the worker", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const worker = fakeWorker(t, phase === "startup" ? { startup: "hang" } : { hang: true });
  const client = new LayaClassifier(); t.after(() => client.close());
  const pending = client.evaluate(input);
  const rejected = assert.rejects(pending, /timed out/);
  // Flush the queue, readiness and inference continuations before ticking.
  for (let i = 0; i < 10; i++) await Promise.resolve();
  t.mock.timers.tick(phase === "startup" ? LAYA_STARTUP_MS : LAYA_INFERENCE_MS);
  await rejected;
  assert.equal((worker.children[0].kill as any).mock.callCount(), 1);
});

test("closing Laya rejects both active and queued requests", async (t) => {
  const worker = fakeWorker(t, { hang: true });
  const client = new LayaClassifier();
  const settled = Promise.allSettled([client.evaluate(input), client.evaluate(input)]);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  client.close();
  assert.ok((await settled).every((result) => result.status === "rejected"));
  assert.equal((worker.children[0].kill as any).mock.callCount(), 1);
});
