import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

type JsonRpcId = string | number;

type JsonRpcRequest = {
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

export type CodexNotification = {
  method: string;
  params: unknown;
};

export type CodexServerRequest = JsonRpcRequest;

export type CodexAppServerOptions = {
  cwd: string;
  env: Readonly<Record<string, string>>;
};

/**
 * JSON-RPC transport for the locally authenticated `codex app-server`.
 * It deliberately never receives an OpenAI API key: authentication remains in
 * the user's Codex CLI session.
 */
export class CodexAppServer {
  private readonly cwd: string;
  private readonly env: Readonly<Record<string, string>>;
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly notificationListeners = new Set<(event: CodexNotification) => void>();
  private readonly stoppedListeners = new Set<(error: Error) => void>();
  private serverRequestHandler:
    | ((request: CodexServerRequest) => Promise<unknown>)
    | undefined;
  private nextId = 1;
  private closed = false;

  constructor(options: CodexAppServerOptions) {
    this.cwd = options.cwd;
    this.env = options.env;
  }

  async start(): Promise<void> {
    if (this.child) return;
    if (this.closed) throw new Error("Codex app-server has already closed.");

    const command = process.platform === "win32" ? "codex.cmd" : "codex";
    const child = spawn(command, ["app-server", "--stdio"], {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // Windows executes .cmd shims through cmd.exe. The command and arguments
      // are constants, never prompt-derived values.
      shell: process.platform === "win32",
    });
    this.child = child;

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    child.on("error", (error) => this.failAll(error));
    child.on("close", (code, signal) => {
      this.child = null;
      if (!this.closed) {
        const error = new Error(
          `Codex app-server stopped unexpectedly (${signal ?? `exit ${code ?? "unknown"}`}).`,
        );
        this.failAll(error);
        for (const listener of this.stoppedListeners) listener(error);
      }
    });

    await this.request("initialize", {
      clientInfo: {
        name: "auto-jev-codex",
        title: "Auto Jev-Codex",
        version: "0.2.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    this.notify("initialized", {});
  }

  onNotification(listener: (event: CodexNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onStopped(listener: (error: Error) => void): () => void {
    this.stoppedListeners.add(listener);
    return () => this.stoppedListeners.delete(listener);
  }

  handleServerRequests(handler: (request: CodexServerRequest) => Promise<unknown>): void {
    this.serverRequestHandler = handler;
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    if (!this.child || this.closed) {
      return Promise.reject(new Error("Codex app-server is not running."));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server timed out while calling '${method}'.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.child || this.closed) return;
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error("Codex app-server closed."));
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.stdin.end();
    child.kill();
  }

  private write(message: Record<string, unknown>): void {
    const child = this.child;
    if (!child || this.closed) throw new Error("Codex app-server is not running.");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // App-server diagnostics may be written to stdout by older CLI builds.
      return;
    }
    // App-server uses JSON-RPC shapes but deliberately omits the `jsonrpc`
    // member on its stdio wire format.
    if (!isRecord(message)) return;

    if (hasId(message) && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if ("error" in message && message.error !== undefined) {
        pending.reject(new Error(describeRpcError(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (hasId(message) && typeof message.method === "string") {
      void this.answerServerRequest({
        id: message.id,
        method: message.method,
        params: message.params,
      });
      return;
    }

    if (typeof message.method === "string") {
      const event: CodexNotification = { method: message.method, params: message.params };
      for (const listener of this.notificationListeners) listener(event);
    }
  }

  private async answerServerRequest(request: CodexServerRequest): Promise<void> {
    try {
      if (!this.serverRequestHandler) {
        throw new Error(`Unsupported Codex server request '${request.method}'.`);
      }
      const result = await this.serverRequestHandler(request);
      this.write({ id: request.id, result });
    } catch (error) {
      this.write({
        id: request.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : "Codex server request failed.",
        },
      });
    }
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasId(value: Record<string, unknown>): value is Record<string, unknown> & { id: JsonRpcId } {
  return typeof value.id === "string" || typeof value.id === "number";
}

function describeRpcError(error: unknown): string {
  if (isRecord(error) && typeof error.message === "string") return error.message;
  return "Codex app-server returned an error.";
}
