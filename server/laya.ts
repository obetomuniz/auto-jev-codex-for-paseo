import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import { settingsSchema } from "../shared/settings";
import { parseRouteAnswers, type RouteAnswers } from "./classifier";
import { readContext, type ContextEntry } from "./route-context";
import { LAYA_QUESTIONS } from "./laya-questions";
import { LAYA_WORKER } from "./laya-worker";

export const LAYA_MAX_BYTES = 65_536;
export const LAYA_MAX_PROMPT_CHARS = 16_000;
export const LAYA_MAX_PENDING = 8;
export const LAYA_STARTUP_MS = 120_000;
export const LAYA_INFERENCE_MS = 30_000;
type LayaInput = {
  python: string;
  model: "english" | "multilingual" | "typed-decisions";
  device: "cpu" | "cuda" | "auto";
  cache?: string;
  prompt: string;
  context?: ContextEntry[];
};
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

// Pass only runtime essentials. In particular, TypeSafe and Codex credentials
// are not part of the worker environment or its JSON protocol.
function workerEnv(cache: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", HF_HUB_DISABLE_TELEMETRY: "1", HF_HUB_DISABLE_IMPLICIT_TOKEN: "1", HF_HUB_DISABLE_SYMLINKS: "1" };
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR", "LOCALAPPDATA", "APPDATA", "CUDA_VISIBLE_DEVICES"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  if (cache) env.HF_HOME = cache;
  return env;
}
class Worker {
  private child: ChildProcessWithoutNullStreams | undefined;
  private pending: Pending | undefined;
  private buffer = Buffer.alloc(0);
  private stopped = false;

  async start(input: LayaInput): Promise<void> {
    const ready = this.wait(LAYA_STARTUP_MS, "Laya startup timed out after 120s. Preload the model and try again.");
    try {
      this.child = spawn(input.python, ["-I", "-u", "-c", LAYA_WORKER, JSON.stringify({ model: input.model, device: input.device })], {
        shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], cwd: homedir(), env: workerEnv(input.cache ?? ""),
      });
      this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
      this.child.stderr.resume(); // Never surface library output that may contain private input.
      this.child.stdin.on("error", () => this.close(new Error("Laya input stream failed.")));
      this.child.on("error", () => this.close(new Error("Could not start Laya. Check the Python executable and install laya==0.3.5 in that environment.")));
      this.child.on("close", () => this.close(new Error("Laya stopped; no Codex turn was started.")));
    } catch {
      this.close(new Error("Could not start the Laya process."));
    }
    const message = await ready;
    if (!isRecord(message) || message.ready !== true) {
      this.close();
      throw new Error("Laya could not load. Check Python, laya==0.3.5, the model cache, and the selected device.");
    }
  }

  async predict(payload: string): Promise<RouteAnswers> {
    if (this.stopped || !this.child) throw new Error("Laya is not running.");
    const response = this.wait(LAYA_INFERENCE_MS, "Laya classification timed out after 30s.");
    this.child.stdin.write(payload + "\n", "utf8");
    const body = await response;
    if (isRecord(body) && typeof body.error === "string") {
      if (body.error === "context") throw new Error("Laya context or questions exceed the model token budget. Shorten the request or start a chat with less context. No Codex turn was started.");
      throw new Error("Laya classification failed. Check the model and selected device. No Codex turn was started.");
    }
    return parseRouteAnswers(body);
  }

  close(error = new Error("Laya was stopped.")): void {
    this.stopped = true;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = undefined;
    }
    this.child?.kill();
    this.child = undefined;
    this.buffer = Buffer.alloc(0);
  }

  private wait(ms: number, message: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject, timer: setTimeout(() => this.close(new Error(message)), ms) };
    });
  }

  private receive(chunk: Buffer): void {
    if (this.stopped) return;
    if (this.buffer.length + chunk.length > LAYA_MAX_BYTES) {
      this.close(new Error("Laya response exceeded 64 KiB."));
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const newline = this.buffer.indexOf(10);
    if (newline < 0) return;
    if (newline !== this.buffer.length - 1 || !this.pending) {
      this.close(new Error("Laya returned an unexpected protocol message."));
      return;
    }
    let body: unknown;
    try { body = JSON.parse(this.buffer.toString("utf8")); }
    catch { this.close(new Error("Laya returned invalid JSON.")); return; }
    this.buffer = Buffer.alloc(0);
    const pending = this.pending;
    this.pending = undefined;
    clearTimeout(pending.timer);
    pending.resolve(body);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class LayaClassifier {
  private worker: Worker | undefined;
  private config = "";
  private tail: Promise<unknown> = Promise.resolve();
  private pendingCount = 0;
  private closed = false;

  evaluate(input: LayaInput): Promise<RouteAnswers> {
    // Validate again at the process boundary, including callers outside settings RPC.
    const settings = settingsSchema.parse({ layaPython: input.python, layaCache: input.cache, layaModel: input.model, layaDevice: input.device });
    input = { ...input, python: settings.layaPython, cache: settings.layaCache, model: settings.layaModel, device: settings.layaDevice };
    if (typeof input.prompt !== "string" || input.prompt.length > LAYA_MAX_PROMPT_CHARS) return Promise.reject(new Error("Laya request exceeds 16,000 characters."));
    const payload = JSON.stringify({ state: { request: input.prompt, recentConversation: readContext(input.context).map(({ role, text }) => ({ role, text })) }, questions: LAYA_QUESTIONS });
    if (Buffer.byteLength(payload + "\n") > LAYA_MAX_BYTES) return Promise.reject(new Error("Laya request exceeds 64 KiB."));
    if (this.closed) return Promise.reject(new Error("Laya classifier is closed."));
    if (this.pendingCount >= LAYA_MAX_PENDING) return Promise.reject(new Error("Laya is busy. Try again after the pending classifications finish."));
    this.pendingCount++;
    const task = this.tail.then(async () => {
      if (this.closed) throw new Error("Laya classifier is closed.");
      const config = JSON.stringify([input.python, input.cache, input.model, input.device]);
      try {
        if (!this.worker || this.config !== config) {
          this.worker?.close();
          this.worker = new Worker();
          this.config = config;
          await this.worker.start(input);
        }
        return await this.worker.predict(payload);
      } catch (error) {
        this.worker?.close();
        this.worker = undefined;
        throw error;
      }
    }).finally(() => { this.pendingCount--; });
    this.tail = task.catch(() => undefined);
    return task;
  }

  close(): void {
    this.closed = true;
    this.worker?.close();
    this.worker = undefined;
  }
}

let classifier: LayaClassifier | undefined;
export function evaluateLayaRoute(input: LayaInput): Promise<RouteAnswers> {
  classifier ??= new LayaClassifier();
  return classifier.evaluate(input);
}
export function disposeLaya(): void {
  classifier?.close();
  classifier = undefined;
}
