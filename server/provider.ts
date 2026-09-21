import type { JsonValue } from "@getpaseo/protocol/agent-types";
import {
  negotiateProviderCapabilities,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderPermissionResponse,
  type ProviderPersistence,
  type ProviderRegistration,
  type ProviderSessionConfig,
  type ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import { CodexAppServer, type CodexNotification, type CodexServerRequest } from "./codex-app-server";
import { type Intent } from "./jev";
import { routePromptWithJev, selectCodexModel } from "./routing";
import { loadSettings } from "./settings-store";
import { appendContext, readContext, type ContextEntry } from "./route-context";
import { collaborationModes, controlSettings, parseControls, type Controls } from "./session-controls";

const PROVIDER_ID = "auto-jev-codex";
const MODEL_ID = "auto-jev-codex";
const SUPPORTED_CAPABILITIES = [
  "prompt.message",
  "prompt.steer",
  "permission",
  "session.persistence",
  "session.configure",
] as const;

type AppServerTurn = { id: string; items?: unknown[] };
type AppServerThread = { id: string; turns?: AppServerTurn[] };
type AppServerTurnsPage = { data?: AppServerTurn[]; nextCursor?: string | null };
type AppServerItemsPage = {
  data?: Array<{ turnId?: string; item?: unknown }>;
  nextCursor?: string | null;
};
type CodexSandboxPolicy =
  | { type: "readOnly"; networkAccess: boolean }
  | { type: "dangerFullAccess" }
  | {
      type: "workspaceWrite";
      writableRoots: string[];
      networkAccess: boolean;
      excludeTmpdirEnvVar: boolean;
      excludeSlashTmp: boolean;
    };
type ComposerPrompt = Extract<ProviderInput, { type: "session.prompt" }>["prompt"];
type ComposerMessageContent = Extract<ComposerPrompt["input"], { type: "message" }>["content"];

type SessionRuntime = {
  id: string;
  config: ProviderSessionConfig;
  codex: CodexAppServer | null;
  threadId: string | null;
  activeTurnId: string | null;
  finishedTurns: Set<string>;
  messages: Map<string, string>;
  permissions: Map<string, PendingPermission>;
  historyRestored: boolean;
  routingContext: ContextEntry[];
  contextLoaded: boolean;
  starting: boolean;
  selectedModel: string;
  mode: "auto" | "default" | "plan";
  controls: Controls;
  closed: boolean;
};

type PendingPermission = {
  request: CodexServerRequest;
  resolve(value: unknown): void;
  reject(reason: Error): void;
  question?: { id: string; options: string[] };
};

export function createAutoJevCodexProvider(): ProviderRegistration {
  return {
    id: PROVIDER_ID,
    label: "Auto Jev-Codex",
    description: "Jev selects a Codex model for every new turn using the local Codex session.",
    async connect(request) {
      return new AutoJevCodexConnection(
        negotiateProviderCapabilities(request.capabilities, SUPPORTED_CAPABILITIES),
      );
    },
  };
}

class AutoJevCodexConnection implements ProviderConnection {
  readonly version = 1;
  readonly capabilities: readonly string[];
  private readonly listeners = new Set<(event: ProviderEvent) => void>();
  private readonly sessions = new Map<string, SessionRuntime>();

  constructor(capabilities: readonly string[]) {
    this.capabilities = capabilities;
  }

  onEvent(listener: (event: ProviderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async send(input: ProviderInput): Promise<void> {
    switch (input.type) {
      case "catalog":
        this.emit({
          type: "catalog",
          requestId: input.requestId,
          catalog: {
            models: await modelCatalog(),
            modes: collaborationModes(),
            defaultMode: "auto",
            defaultModel: MODEL_ID,
          },
        });
        return;
      case "session.open":
        await this.openSession(input);
        return;
      case "session.configure":
        await this.configureSession(input);
        return;
      case "session.prompt":
        await this.prompt(input.sessionId, input.prompt);
        return;
      case "session.interrupt":
        await this.interrupt(input.sessionId, input.requestId);
        return;
      case "session.permission":
        await this.respondToPermission(input.sessionId, input.permissionId, input.response);
        return;
      case "session.close":
        await this.closeSession(input.sessionId);
        this.emit({ type: "session.closed", sessionId: input.sessionId });
        this.emit({ type: "request.completed", requestId: input.requestId });
        return;
      default:
        if ("requestId" in input) {
          this.emit({
            type: "request.failed",
            requestId: input.requestId,
            error: { message: `${input.type} is not supported by Auto Jev-Codex.` },
          });
        }
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.closeSession(sessionId)));
    this.listeners.clear();
  }

  private async openSession(input: Extract<ProviderInput, { type: "session.open" }>): Promise<void> {
    if (this.sessions.has(input.sessionId)) {
      this.emit({
        type: "request.failed",
        requestId: input.requestId,
        error: { message: "Auto Jev-Codex session is already open." },
      });
      return;
    }
    const saved = asRecord(input.persistence?.data);
    const selectedModel = input.config.model ?? stringValue(saved?.selectedModel) ?? MODEL_ID;
    const mode = input.config.mode ?? stringValue(saved?.mode) ?? "auto";
    const models = await modelCatalog();
    let controls: Controls;
    try {
      // Full access comes only from explicit host configuration, never routing or saved provider data.
      const storedControls = asRecord(saved?.controls) ?? {};
      controls = parseControls(input.config.settings, parseControls({
        fast: storedControls.fast === "on" || storedControls.fast === "off" ? storedControls.fast : "auto",
        modelScope: storedControls.modelScope === "pinned" ? "pinned" : "next-turn",
      }));
      if (!models.some((model) => model.id === selectedModel) || (mode !== "auto" && mode !== "default" && mode !== "plan")) {
        throw new Error("Choose a configured model and a supported collaboration mode.");
      }
    } catch (error) {
      this.emit({ type: "request.failed", requestId: input.requestId, error: { message: String(error) } });
      return;
    }
    const session: SessionRuntime = {
      id: input.sessionId,
      config: input.config,
      codex: null,
      threadId: threadIdFromPersistence(input.persistence),
      activeTurnId: null,
      finishedTurns: new Set(),
      messages: new Map(),
      permissions: new Map(),
      historyRestored: false,
      routingContext: readContext(saved?.routingContext),
      contextLoaded: Array.isArray(saved?.routingContext) || !threadIdFromPersistence(input.persistence),
      starting: false,
      selectedModel,
      mode: mode as "auto" | "default" | "plan",
      controls,
      closed: false,
    };
    this.sessions.set(session.id, session);
    this.emit({
      type: "session.opened",
      requestId: input.requestId,
      sessionId: session.id,
      capabilities: this.capabilities,
      restoration: "core",
      ...(session.threadId ? { persistence: persistenceFor(session) } : {}),
      title: input.config.title,
      cwd: input.config.cwd,
    });
    this.emit({
      type: "session.config",
      sessionId: session.id,
      config: {
        model: session.selectedModel,
        mode: session.mode,
        models,
        modes: collaborationModes(),
        thinkingOptions: [],
        settings: controlSettings(session.controls),
      },
    });
    if (input.history === "replay" && session.threadId) {
      try {
        await this.restoreHistory(session);
      } catch (error) {
        this.emitTimeline(session.id, {
          type: "notification",
          id: `history-restore:${session.id}`,
          level: "warning",
          message: error instanceof Error
            ? `Could not restore the previous Codex timeline: ${error.message}`
            : "Could not restore the previous Codex timeline.",
        });
      }
    }
    this.emit({ type: "session.ready", requestId: input.requestId, sessionId: session.id });
  }

  private async configureSession(input: Extract<ProviderInput, { type: "session.configure" }>): Promise<void> {
    try {
      const session = this.sessions.get(input.sessionId);
      if (!session || session.closed || session.starting) throw new Error("Wait for the pending turn to start before changing settings.");
      const models = await modelCatalog();
      if (session.closed || session.starting) throw new Error("Session changed while loading configuration; try again.");
      const model = input.changes.model === undefined ? session.selectedModel : input.changes.model ?? MODEL_ID;
      const mode = input.changes.mode === undefined ? session.mode : input.changes.mode ?? "auto";
      if (!models.some((item) => item.id === model) || (mode !== "auto" && mode !== "default" && mode !== "plan") || input.changes.thinkingOption !== undefined) {
        throw new Error("Choose a configured model and a supported collaboration mode.");
      }
      const controls = parseControls(input.changes.settings ?? {}, session.controls);
      session.selectedModel = model;
      session.mode = mode;
      session.controls = controls;
      this.emitConfig(session, models);
      this.persist(session);
      this.emit({ type: "request.completed", requestId: input.requestId });
    } catch (error) {
      this.emit({ type: "request.failed", requestId: input.requestId, error: { message: String(error) } });
    }
  }

  private emitConfig(session: SessionRuntime, models: Awaited<ReturnType<typeof modelCatalog>>): void {
    this.emit({ type: "session.config", sessionId: session.id, config: {
      model: session.selectedModel, mode: session.mode, models,
      modes: collaborationModes(), thinkingOptions: [], settings: controlSettings(session.controls),
    } });
  }

  private persist(session: SessionRuntime): void {
    if (session.threadId && !session.closed) this.emit({ type: "session.persistence", sessionId: session.id, persistence: persistenceFor(session) });
  }

  private remember(session: SessionRuntime, entry: ContextEntry): void {
    session.routingContext = appendContext(session.routingContext, entry);
    this.persist(session);
  }

  private async prompt(
    sessionId: string,
    prompt: ComposerPrompt,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) {
      this.emitPromptFailure(sessionId, prompt.clientMessageId, "Auto Jev-Codex session is not open.");
      return;
    }
    if (session.starting || (session.activeTurnId && prompt.delivery !== "steer")) {
      this.emitPromptFailure(sessionId, prompt.clientMessageId, "Wait for the current turn to finish before sending another message.");
      return;
    }
    if (prompt.input.type !== "message") {
      this.emitPromptFailure(sessionId, prompt.clientMessageId, "Composer commands are not supported by Auto Jev-Codex.");
      return;
    }
    const text = messageText(prompt.input.content);
    if (!text) {
      this.emitPromptFailure(sessionId, prompt.clientMessageId, "Auto Jev-Codex currently supports text messages only.");
      return;
    }

    this.emit({
      type: "timeline.item",
      sessionId,
      item: {
        type: "user_message",
        id: prompt.clientMessageId,
        text,
        clientMessageId: prompt.clientMessageId,
      },
    });

    session.starting = true;
    try {
      if (session.activeTurnId && prompt.delivery === "steer") {
        const codex = session.codex;
        if (!codex || !session.threadId) {
          throw new Error("Codex is not ready to steer the active turn.");
        }
        const response = await codex.request<{ turnId: string }>("turn/steer", {
          threadId: session.threadId,
          expectedTurnId: session.activeTurnId,
          clientUserMessageId: prompt.clientMessageId,
          input: [{ type: "text", text, text_elements: [] }],
        });
        this.remember(session, { id: prompt.clientMessageId, role: "user", text });
        this.emit({
          type: "session.prompt_result",
          sessionId,
          clientMessageId: prompt.clientMessageId,
          result: { type: "steer", turnId: response.turnId },
        });
        return;
      }

      if (session.threadId && !session.contextLoaded) await this.restoreHistory(session, false);
      const route = await routePromptWithJev(text, session.routingContext);
      if (session.closed) return;
      const manual = session.selectedModel !== MODEL_ID;
      const model = manual ? session.selectedModel : route.model;
      const plan = session.mode === "plan" || (session.mode === "auto" && route.plan);
      const fast = session.controls.fast === "on" || (session.controls.fast === "auto" && route.fast);
      const models = await modelCatalog();
      if (session.closed) return;
      this.emit({
        type: "timeline.item",
        sessionId,
        item: {
          type: "notification",
          id: `jev-route:${prompt.clientMessageId}`,
          level: "info",
          message: `${manual ? "Manual model" : "Jev selected"} ${model}: ${route.intent}, ${route.lane}, ${route.effort}. Intent confidence: ${Math.round(route.confidence * 100)}%. Classification: ${route.classificationMs}ms. Context: ${session.routingContext.length} messages. Fast: ${fast ? "on" : "off"}. Plan: ${plan ? "on" : "off"}. Permissions: ${plan ? "plan (read-only)" : session.controls.permissions}.`,
        },
      });
      const codex = await this.ensureCodex(session, model);
      if (session.closed) return;
      const previousContext = session.routingContext;
      session.routingContext = appendContext(previousContext, { id: prompt.clientMessageId, role: "user", text });
      const response = await codex.request<{ turn: AppServerTurn }>("turn/start", {
        threadId: session.threadId,
        clientUserMessageId: prompt.clientMessageId,
        input: [{ type: "text", text, text_elements: [] }],
        model,
        effort: route.effort,
        sandboxPolicy: plan ? { type: "readOnly", networkAccess: true }
          : session.controls.permissions === "full-access" ? { type: "dangerFullAccess" }
          : sandboxForIntent(route.intent, session.config.cwd),
        approvalPolicy: session.controls.permissions === "full-access" && !plan ? "never" : "on-request",
        approvalsReviewer: "auto_review",
        serviceTier: fast ? "fast" : "default",
        collaborationMode: {
          mode: plan ? "plan" : "default",
          settings: { model, reasoning_effort: route.effort, developer_instructions: null },
        },
      }).catch((error) => {
        session.routingContext = previousContext;
        throw error;
      });
      this.persist(session);
      session.contextLoaded = true;
      if (manual && session.controls.modelScope === "next-turn") {
        session.selectedModel = MODEL_ID;
        this.emitConfig(session, models);
        this.persist(session);
      }
      const turnId = response.turn.id;
      session.activeTurnId = session.finishedTurns.has(turnId) ? null : turnId;
      this.emit({
        type: "session.prompt_result",
        sessionId,
        clientMessageId: prompt.clientMessageId,
        result: { type: "turn", turnId },
      });
      this.emit({ type: "session.turn", sessionId, turnId, state: "started" });
    } catch (error) {
      this.emitPromptFailure(
        sessionId,
        prompt.clientMessageId,
        error instanceof Error ? error.message : "Could not start the Auto Jev-Codex turn.",
      );
    } finally {
      session.starting = false;
    }
  }

  private async ensureCodex(session: SessionRuntime, model: string): Promise<CodexAppServer> {
    if (session.codex && session.threadId) return session.codex;
    const codex = new CodexAppServer({ cwd: session.config.cwd, env: session.config.env });
    codex.onNotification((notification) => this.handleCodexNotification(session, notification));
    codex.onStopped((error) => {
      if (session.closed) return;
      session.activeTurnId = null;
      this.emit({ type: "session.runtime_failed", sessionId: session.id, error: { message: error.message } });
    });
    codex.handleServerRequests((request) => this.requestPermission(session, request));
    session.codex = codex;
    try {
      await codex.start();
      if (session.closed) throw new Error("Session closed before Codex started.");
      const response = session.threadId
        ? await codex.request<{ thread: AppServerThread }>("thread/resume", {
            threadId: session.threadId,
            cwd: session.config.cwd,
            approvalPolicy: "on-request",
            approvalsReviewer: "auto_review",
            sandbox: "read-only",
          })
        : await codex.request<{ thread: AppServerThread }>("thread/start", {
            cwd: session.config.cwd,
            model,
            developerInstructions: session.config.systemPrompt ?? null,
            approvalPolicy: "on-request",
            approvalsReviewer: "auto_review",
            sandbox: "read-only",
          });
      session.threadId = response.thread.id;
      this.emit({
        type: "session.persistence",
        sessionId: session.id,
        persistence: persistenceFor(session),
      });
      return codex;
    } catch (error) {
      session.codex = null;
      await codex.close();
      throw error;
    }
  }

  private async restoreHistory(session: SessionRuntime, replay = true): Promise<void> {
    if (session.historyRestored || !session.threadId) return;
    const codex = await this.ensureCodex(session, "gpt-6-astra");
    const turns = await this.readHistoryTurns(codex, session.threadId);
    session.routingContext = [];
    for (const turn of turns) {
      const items = await this.readTurnItems(codex, session.threadId, turn);
      for (const item of items) {
        this.captureHistoricalContext(session, item);
        if (replay) this.emitHistoricalItem(session, item);
      }
    }
    session.historyRestored = true;
    session.contextLoaded = true;
    this.persist(session);
  }

  private async readHistoryTurns(codex: CodexAppServer, threadId: string): Promise<AppServerTurn[]> {
    const response = await codex.request<{ thread: AppServerThread }>("thread/read", {
      threadId,
      includeTurns: true,
    });
    const legacyTurns = Array.isArray(response.thread.turns) ? response.thread.turns : [];
    if (legacyTurns.length > 0) return legacyTurns;

    const turns: AppServerTurn[] = [];
    let cursor: string | null = null;
    do {
      const page: AppServerTurnsPage = await codex.request("thread/turns/list", {
        threadId,
        cursor,
        limit: 100,
        sortDirection: "asc",
        itemsView: "full",
      });
      if (Array.isArray(page.data)) turns.push(...page.data);
      cursor = typeof page.nextCursor === "string" ? page.nextCursor : null;
    } while (cursor);
    return turns;
  }

  private async readTurnItems(
    codex: CodexAppServer,
    threadId: string,
    turn: AppServerTurn,
  ): Promise<unknown[]> {
    if (Array.isArray(turn.items) && turn.items.length > 0) return turn.items;

    const items: unknown[] = [];
    let cursor: string | null = null;
    do {
      const page: AppServerItemsPage = await codex.request("thread/items/list", {
        threadId,
        turnId: turn.id,
        cursor,
        limit: 100,
        sortDirection: "asc",
      });
      if (Array.isArray(page.data)) {
        for (const entry of page.data) {
          if (entry.turnId === undefined || entry.turnId === turn.id) items.push(entry.item);
        }
      }
      cursor = typeof page.nextCursor === "string" ? page.nextCursor : null;
    } while (cursor);
    return items;
  }

  private captureHistoricalContext(session: SessionRuntime, raw: unknown): void {
    const item = asRecord(raw);
    if (!item || typeof item.id !== "string") return;
    const role = item.type === "userMessage" ? "user" : item.type === "agentMessage" ? "assistant" : item.type === "plan" ? "plan" : null;
    if (!role) return;
    const text = role === "user" ? historicalUserText(item.content) : stringValue(item.text) ?? "";
    const id = role === "user" ? stringValue(item.clientId) ?? item.id : item.id;
    session.routingContext = appendContext(session.routingContext, { id, role, text });
  }

  private emitHistoricalItem(session: SessionRuntime, rawItem: unknown): void {
    const item = asRecord(rawItem);
    const itemId = item && stringValue(item.id);
    const type = item && stringValue(item.type);
    if (!item || !itemId || !type) return;
    if (type === "userMessage") {
      const text = historicalUserText(item.content);
      if (!text) return;
      const clientMessageId = stringValue(item.clientId) ?? itemId;
      this.emitTimeline(session.id, {
        type: "user_message",
        id: itemId,
        text,
        clientMessageId,
      });
      return;
    }
    this.emitCompletedItem(session, item);
  }

  private handleCodexNotification(session: SessionRuntime, notification: CodexNotification): void {
    const params = asRecord(notification.params);
    if (params && typeof params.threadId === "string" && params.threadId !== session.threadId) return;

    if (notification.method === "item/agentMessage/delta" && params) {
      const itemId = stringValue(params.itemId);
      const delta = stringValue(params.delta);
      if (!itemId || !delta) return;
      const text = `${session.messages.get(itemId) ?? ""}${delta}`;
      session.messages.set(itemId, text);
      this.emitTimeline(session.id, { type: "assistant_message", id: itemId, text });
      return;
    }

    if (notification.method === "item/reasoning/summaryTextDelta" && params) {
      const itemId = stringValue(params.itemId);
      const delta = stringValue(params.delta);
      if (!itemId || !delta) return;
      const text = `${session.messages.get(itemId) ?? ""}${delta}`;
      session.messages.set(itemId, text);
      this.emitTimeline(session.id, { type: "reasoning", id: itemId, text });
      return;
    }

    if (notification.method === "item/completed" && params) {
      const item = asRecord(params.item);
      if (item) {
        this.captureHistoricalContext(session, item);
        this.persist(session);
        this.emitCompletedItem(session, item);
      }
      return;
    }

    if (notification.method === "turn/completed" && params) {
      const turn = asRecord(params.turn);
      const turnId = turn && stringValue(turn.id);
      if (!turnId) return;
      const status = stringValue(turn.status);
      const error = asRecord(turn.error);
      const message = error && stringValue(error.message);
      const state = status === "completed" ? "completed" : status === "interrupted" ? "canceled" : "failed";
      this.emit({
        type: "session.turn",
        sessionId: session.id,
        turnId,
        state,
        ...(message ? { error: { message } } : {}),
      });
      session.finishedTurns.add(turnId);
      if (session.activeTurnId === turnId) session.activeTurnId = null;
      return;
    }

    if (notification.method === "warning" && params) {
      const message = stringValue(params.message);
      if (message) {
        this.emitTimeline(session.id, {
          type: "notification",
          id: `codex-warning:${Date.now()}`,
          level: "warning",
          message,
        });
      }
    }
  }

  private emitCompletedItem(session: SessionRuntime, item: Record<string, unknown>): void {
    const itemId = stringValue(item.id);
    const type = stringValue(item.type);
    if (!itemId || !type) return;
    if (type === "agentMessage") {
      const text = stringValue(item.text) ?? session.messages.get(itemId) ?? "";
      session.messages.set(itemId, text);
      this.emitTimeline(session.id, { type: "assistant_message", id: itemId, text });
      return;
    }
    if (type === "reasoning") {
      const summary = strings(item.summary).join("\n");
      if (summary) this.emitTimeline(session.id, { type: "reasoning", id: itemId, text: summary });
      return;
    }
    if (type === "plan") {
      const text = stringValue(item.text);
      if (text) this.emitTimeline(session.id, { type: "reasoning", id: itemId, text });
      return;
    }
    if (type === "commandExecution") {
      const status = stringValue(item.status);
      const exitCode = numberOrNull(item.exitCode);
      const cwd = stringValue(item.cwd);
      const output = stringValue(item.aggregatedOutput);
      const detail = {
        type: "shell" as const,
        command: stringValue(item.command) ?? "",
        ...(cwd ? { cwd } : {}),
        ...(output ? { output } : {}),
        exitCode,
      };
      const base = { type: "tool_call" as const, id: itemId, callId: itemId, name: "command", detail };
      if (status === "completed") {
        this.emitTimeline(session.id, { ...base, status: "completed", error: null });
      } else if (status === "declined") {
        this.emitTimeline(session.id, { ...base, status: "canceled", error: null });
      } else {
        this.emitTimeline(session.id, {
          ...base,
          status: "failed",
          error: { message: "Command failed." },
        });
      }
    }
  }

  private async requestQuestions(session: SessionRuntime, request: CodexServerRequest): Promise<unknown> {
    const params = asRecord(request.params);
    if (!Array.isArray(params?.questions)) throw new Error("Invalid Codex questions.");
    const answers: Record<string, { answers: string[] }> = {};
    for (const raw of params.questions) {
      if (session.closed) throw new Error("Session closed.");
      const question = asRecord(raw);
      if (!question || typeof question.id !== "string" || typeof question.question !== "string") throw new Error("Invalid Codex question.");
      const options = Array.isArray(question.options) ? question.options.map(asRecord).filter((item) => item && typeof item.label === "string") : [];
      const labels = options.map((option) => String(option!.label));
      const permissionId = "codex:" + String(request.id) + ":" + question.id;
      const answer = new Promise<string[]>((resolve, reject) => {
        session.permissions.set(permissionId, {
          request, resolve: (value) => resolve(value as string[]), reject,
          question: { id: question.id as string, options: labels },
        });
      });
      this.emit({
        type: "session.permission", sessionId: session.id,
        request: {
          id: permissionId, name: "Plan question", kind: "question",
          title: stringValue(question.header) ?? "Question",
          description: question.question + options.map((option) => "\n" + option!.label + ": " + (option!.description ?? "")).join(""),
          input: jsonRecord({ questions: [question] }),
          actions: [
            ...labels.map((label, index) => ({ id: "answer:" + index, label, behavior: "allow" as const })),
            { id: "skip", label: "Skip", behavior: "deny" },
          ],
        },
      });
      answers[question.id] = { answers: await answer };
    }
    return { answers };
  }

  private async requestPermission(
    session: SessionRuntime,
    request: CodexServerRequest,
  ): Promise<unknown> {
    if (request.method === "item/tool/requestUserInput") return this.requestQuestions(session, request);
    if (!isApprovalRequest(request.method)) {
      throw new Error(`Auto Jev-Codex does not yet support '${request.method}'.`);
    }
    const permissionId = `codex:${String(request.id)}`;
    const params = asRecord(request.params) ?? {};
    const command = stringValue(params.command);
    const reason = stringValue(params.reason);
    this.emit({
      type: "session.permission",
      sessionId: session.id,
      request: {
        id: permissionId,
        name: command ? "Run command" : "Codex approval",
        kind: "tool",
        title: command ?? undefined,
        description: reason ?? approvalDescription(request.method),
        input: jsonRecord(params),
        actions: [
          { id: "approve", label: "Allow", behavior: "allow", variant: "primary" },
          { id: "deny", label: "Deny", behavior: "deny", variant: "danger" },
        ],
      },
    });
    return new Promise<unknown>((resolve, reject) => {
      session.permissions.set(permissionId, { request, resolve, reject });
    });
  }

  private async respondToPermission(
    sessionId: string,
    permissionId: string,
    response: ProviderPermissionResponse,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    const pending = session?.permissions.get(permissionId);
    if (!session || !pending) {
      throw new Error(`Unknown Auto Jev-Codex permission '${permissionId}'.`);
    }
    if (pending.question) {
      let answers: string[] = [];
      if (response.behavior === "allow") {
        const freeText = response.updatedInput?.answer;
        const selected = response.selectedActionId;
        if (typeof freeText === "string" && freeText.trim()) answers = [freeText.trim()];
        else if (selected && /^answer:\d+$/.test(selected)) {
          const label = pending.question.options[Number(selected.slice(7))];
          if (label) answers = [label];
        }
        if (!answers.length) throw new Error("Choose an answer or skip the question.");
      }
      session.permissions.delete(permissionId);
      pending.resolve(answers);
      this.emit({ type: "session.permission_resolved", sessionId, permissionId });
      return;
    }
    session.permissions.delete(permissionId);
    const allowed = response.behavior === "allow";
    pending.resolve(approvalResult(pending.request.method, pending.request.params, allowed, response));
    this.emit({ type: "session.permission_resolved", sessionId, permissionId });
  }

  private async interrupt(sessionId: string, requestId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session?.codex || !session.threadId || !session.activeTurnId) {
      this.emit({ type: "request.completed", requestId });
      return;
    }
    try {
      await session.codex.request("turn/interrupt", {
        threadId: session.threadId,
        turnId: session.activeTurnId,
      });
      this.emit({ type: "request.completed", requestId });
    } catch (error) {
      this.emit({
        type: "request.failed",
        requestId,
        error: { message: error instanceof Error ? error.message : "Could not interrupt Codex." },
      });
    }
  }

  private async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.closed = true;
    this.sessions.delete(sessionId);
    for (const pending of session.permissions.values()) {
      pending.reject(new Error("Auto Jev-Codex session closed."));
    }
    session.permissions.clear();
    await session.codex?.close();
  }

  private emitPromptFailure(sessionId: string, clientMessageId: string, message: string): void {
    this.emit({
      type: "session.prompt_result",
      sessionId,
      clientMessageId,
      result: { type: "failed", error: { message } },
    });
  }

  private emitTimeline(sessionId: string, item: ProviderTimelineItem): void {
    this.emit({ type: "timeline.item", sessionId, item });
  }

  private emit(event: ProviderEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

async function modelCatalog() {
  const settings = await loadSettings();
  const ids = [...new Set((["staff", "review", "cheap", "lead"] as const).map((lane) => selectCodexModel(lane, settings)))];
  return [autoModel(), ...ids.filter((id) => id !== MODEL_ID).map((id) => ({
    id, label: id, description: "Manual model; Jev still classifies the request and selects effort.", isDefault: false,
  }))];
}

function autoModel() {
  return {
    id: MODEL_ID,
    label: "Auto Jev-Codex",
    description: "Jev chooses the Codex model before every new turn.",
    isDefault: true,
  };
}

function sandboxForIntent(intent: Intent, cwd: string): CodexSandboxPolicy {
  if (intent === "implement") {
    return {
      type: "workspaceWrite",
      writableRoots: [cwd],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }
  return { type: "readOnly", networkAccess: true };
}

function messageText(content: ComposerMessageContent): string {
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function historicalUserText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const input = asRecord(part);
      return input && input.type === "text" ? stringValue(input.text) ?? "" : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function jsonRecord(value: Record<string, unknown>): Record<string, JsonValue> {
  return value as Record<string, JsonValue>;
}

function threadIdFromPersistence(persistence: ProviderPersistence | undefined): string | null {
  if (!persistence || persistence.version !== 1) return null;
  return stringValue(asRecord(persistence.data)?.threadId);
}

function persistenceFor(session: SessionRuntime): ProviderPersistence {
  return { version: 1, data: {
    threadId: session.threadId, routingContext: session.routingContext,
    selectedModel: session.selectedModel, mode: session.mode,
    controls: { fast: session.controls.fast, modelScope: session.controls.modelScope },
  } };
}

function isApprovalRequest(method: string): boolean {
  return [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "execCommandApproval",
    "applyPatchApproval",
  ].includes(method);
}

function approvalDescription(method: string): string {
  if (method.includes("fileChange") || method === "applyPatchApproval") {
    return "Codex requested permission to modify files.";
  }
  if (method.includes("permissions")) {
    return "Codex requested additional permissions for this turn.";
  }
  return "Codex requested permission to perform an action.";
}

function approvalResult(
  method: string,
  params: unknown,
  allowed: boolean,
  response: ProviderPermissionResponse,
): unknown {
  if (method === "item/commandExecution/requestApproval") {
    return { decision: allowed ? "accept" : "decline" };
  }
  if (method === "item/fileChange/requestApproval") {
    return { decision: allowed ? "accept" : "decline" };
  }
  if (method === "item/permissions/requestApproval") {
    const requested = asRecord(params)?.permissions ?? {};
    return { permissions: allowed ? requested : {}, scope: "turn" };
  }
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    return allowed
      ? { decision: "approved" }
      : { decision: { denied: { rejection: response.behavior === "deny" ? response.message ?? "Denied in Paseo." : "Denied in Paseo." } } };
  }
  throw new Error(`Unsupported Codex approval '${method}'.`);
}
