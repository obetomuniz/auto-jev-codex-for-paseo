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
import { type Intent } from "./classifier";
import { routePrompt } from "./routing";
import { loadSettings } from "./settings-store";
import { appendContext, readContext, type ContextEntry } from "./route-context";
import { collaborationModes, controlSettings, parseControls, type Controls } from "./session-controls";

import { parseQuestions, questionAnswers, type Questions } from "./questions";
import { PaseoExecution, type PaseoAccess } from "./paseo-execution";
import { appendHandoff, readHandoff, handoffPrompt } from "./handoff";
import { executionNotice } from "./execution-notice";
import { readWorkspaceState } from "./workspace-state";

type JsonValue = ProviderSessionConfig["settings"][string];

const PROVIDER_ID = "auto-mode-for-paseo";
const MODEL_ID = "auto-mode-for-paseo";
const SUPPORTED_CAPABILITIES = [
  "prompt.message",
  "prompt.image",
  "prompt.steer",
  "permission",
  "session.persistence",
  "session.configure",
] as const;

export const MAX_IMAGES_PER_MESSAGE = 4;
export const MAX_IMAGE_BYTES_PER_IMAGE = 5 * 1024 * 1024;

const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_IMAGE_BASE64_LENGTH = Math.ceil(MAX_IMAGE_BYTES_PER_IMAGE / 3) * 4;

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
type ComposerImageContent = Extract<ComposerMessageContent[number], { type: "image" }>;
type CodexTurnInput =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "image"; url: string };
type PreparedComposerMessage = {
  displayText: string;
  routeText: string;
  contextText: string;
  codexInput: CodexTurnInput[];
};

type SessionRuntime = {
  id: string;
  config: ProviderSessionConfig;
  codex: CodexAppServer | null;
  native: PaseoExecution | null;
  handoffContext: ContextEntry[];
  lastProvider: string | null;
  generation: number;
  threadId: string | null;
  activeTurnId: string | null;
  finishedTurns: Set<string>;
  deferredTurns: ProviderEvent[];
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
  questions?: Questions;
};

export function createAutoModeProvider(paseo?: PaseoAccess): ProviderRegistration {
  return {
    id: PROVIDER_ID,
    label: "Auto Mode for Paseo",
    description: "Route each turn to a configured persona and its provider.",
    async connect(request) {
      return new AutoModeConnection(
        negotiateProviderCapabilities(request.capabilities, SUPPORTED_CAPABILITIES), paseo,
      );
    },
  };
}

class AutoModeConnection implements ProviderConnection {
  readonly version = 1;
  readonly capabilities: readonly string[];
  private readonly listeners = new Set<(event: ProviderEvent) => void>();
  private readonly sessions = new Map<string, SessionRuntime>();

  constructor(capabilities: readonly string[], private readonly paseo?: PaseoAccess) {
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
            error: { message: `${input.type} is not supported by Auto Mode for Paseo.` },
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
        error: { message: "Auto Mode for Paseo session is already open." },
      });
      return;
    }
    const saved = asRecord(input.persistence?.data);
    const requestedModel = input.config.model ?? stringValue(saved?.selectedModel) ?? MODEL_ID;
    const selectedModel = await normalizePersonaSelection(requestedModel);
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
      native: null,
      handoffContext: readHandoff(saved?.handoffContext ?? saved?.routingContext),
      lastProvider: stringValue(saved?.lastProvider) ?? (threadIdFromPersistence(input.persistence) ? "codex" : null),
      generation: 0,
      threadId: threadIdFromPersistence(input.persistence),
      activeTurnId: null,
      finishedTurns: new Set(),
      deferredTurns: [],
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
    if (input.history === "replay" && session.lastProvider && session.lastProvider !== "codex") {
      for (const entry of session.handoffContext) {
        this.emitTimeline(session.id, { type: entry.role === "user" ? "user_message" : "assistant_message", id: entry.id, text: entry.text });
      }
    } else if (input.history === "replay" && session.threadId) {
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
      const model = input.changes.model === undefined ? session.selectedModel : await normalizePersonaSelection(input.changes.model ?? MODEL_ID);
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
    if (session.config.persist && !session.closed) this.emit({ type: "session.persistence", sessionId: session.id, persistence: persistenceFor(session) });
  }

  private remember(session: SessionRuntime, entry: ContextEntry): void {
    session.routingContext = appendContext(session.routingContext, entry);
    session.handoffContext = appendHandoff(session.handoffContext, entry);
    this.persist(session);
  }

  private async prompt(
    sessionId: string,
    prompt: ComposerPrompt,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) {
      this.emitPromptFailure(sessionId, prompt.clientMessageId, "Auto Mode for Paseo session is not open.");
      return;
    }
    if (session.starting || (session.activeTurnId && prompt.delivery !== "steer")) {
      this.emitPromptFailure(sessionId, prompt.clientMessageId, "Wait for the current turn to finish before sending another message.");
      return;
    }
    if (prompt.input.type !== "message") {
      this.emitPromptFailure(sessionId, prompt.clientMessageId, "Composer commands are not supported by Auto Mode for Paseo.");
      return;
    }
    let message: PreparedComposerMessage;
    try {
      message = prepareComposerMessage(prompt.input.content);
    } catch (error) {
      this.emitPromptFailure(
        sessionId,
        prompt.clientMessageId,
        error instanceof Error ? error.message : "Could not read the attached image.",
      );
      return;
    }

    this.emit({
      type: "timeline.item",
      sessionId,
      item: {
        type: "user_message",
        id: prompt.clientMessageId,
        text: message.displayText,
        clientMessageId: prompt.clientMessageId,
      },
    });

    session.starting = true;
    const generation = session.generation;
    try {
      if (session.activeTurnId && prompt.delivery === "steer") {
        if (session.native) throw new Error("This provider cannot steer an active turn through Paseo. Wait for it to finish or interrupt it first.");
        const codex = session.codex;
        if (!codex || !session.threadId) {
          throw new Error("Codex is not ready to steer the active turn.");
        }
        const response = await codex.request<{ turnId: string }>("turn/steer", {
          threadId: session.threadId,
          expectedTurnId: session.activeTurnId,
          clientUserMessageId: prompt.clientMessageId,
          input: message.codexInput,
        });
        this.remember(session, { id: prompt.clientMessageId, role: "user", text: message.contextText });
        this.emit({
          type: "session.prompt_result",
          sessionId,
          clientMessageId: prompt.clientMessageId,
          result: { type: "steer", turnId: response.turnId },
        });
        return;
      }

      if (session.threadId && !session.contextLoaded) await this.restoreHistory(session, false);
      const manual = session.selectedModel !== MODEL_ID;
      const settings = await loadSettings();
      const workspace = await readWorkspaceState(session.config.cwd);
      if (session.closed || session.generation !== generation) throw new Error("Turn canceled during workspace assessment.");
      const route = await routePrompt(message.routeText, session.routingContext, settings, manual ? session.selectedModel : undefined, workspace);
      if (session.closed || session.generation !== generation) throw new Error("Turn canceled during classification.");
      const persona = settings.personas.find((item) => item.id === route.personaId)!;
      const model = persona.model;
      const effort = persona.effort;
      const plan = session.mode === "plan" || (session.mode === "auto" && route.plan);
      const fast = session.controls.fast === "on" || (session.controls.fast === "auto" && route.fast);
      const models = await modelCatalog();
      if (session.closed || session.generation !== generation) throw new Error("Turn canceled during configuration.");
      // Wait for the prior native run to stop before starting any replacement.
      await session.native?.close();
      session.native = null;
      if (session.closed || session.generation !== generation) throw new Error("Turn canceled before provider startup.");
      if (persona.provider !== "codex") {
        if (!this.paseo) throw new Error("The Paseo host API is not available for this session.");
        await session.codex?.close();
        session.codex = null;
        if (session.closed || session.generation !== generation) throw new Error("Turn canceled before provider startup.");
        const execution = new PaseoExecution(this.paseo(), session.id, (event) => {
          if (session.closed) return;
          if (event.type === "timeline.item" && event.item.type === "assistant_message") {
            this.remember(session, { id: event.item.id, role: "assistant", text: event.item.text });
          }
          if (event.type === "session.turn" && event.state !== "started") {
            if (session.activeTurnId === event.turnId) session.activeTurnId = null;
            session.finishedTurns.add(event.turnId);
          }
          this.emit(event);
        });
        session.native = execution;
        await execution.start({
          config: session.config, persona, manual, taskDepth: route.taskDepth, taskType: manual ? undefined : route.taskType, notices: route.notices,
          policy: { provider: persona.provider, intent: route.intent, plan, fast, cwd: session.config.cwd, fullAccess: session.controls.permissions === "full-access" },
          context: session.handoffContext, text: message.displayText,
          images: prompt.input.content.filter((part): part is ComposerImageContent => part.type === "image").map(({ data, mimeType }) => ({ data, mimeType })),
          clientMessageId: prompt.clientMessageId,
          accepted: () => {
            session.activeTurnId = execution.turnId;
            session.lastProvider = persona.provider;
            this.remember(session, { id: prompt.clientMessageId, role: "user", text: message.contextText });
            if (manual && session.controls.modelScope === "next-turn") {
              session.selectedModel = MODEL_ID;
              this.emitConfig(session, models);
              this.persist(session);
            }
          },
        });
        return;
      }
      session.native = null;
      const returningToCodex = session.lastProvider !== null && session.lastProvider !== "codex";
      const codex = await this.ensureCodex(session, model);
      if (session.closed || session.generation !== generation) throw new Error("Turn canceled during provider startup.");
      const previousContext = session.routingContext;
      const previousHandoff = session.handoffContext;
      session.handoffContext = appendHandoff(previousHandoff, { id: prompt.clientMessageId, role: "user", text: message.contextText });
      session.routingContext = appendContext(previousContext, {
        id: prompt.clientMessageId,
        role: "user",
        text: message.contextText,
      });
      const modeLabel = plan ? "Plan" : session.controls.permissions === "full-access" ? "Full access"
        : persona.workMode === "auto" ? "Default Permissions" : "Auto-review";
      const response = await codex.request<{ turn: AppServerTurn }>("turn/start", {
        threadId: session.threadId,
        clientUserMessageId: prompt.clientMessageId,
        input: returningToCodex ? [{ type: "text", text: handoffPrompt(previousHandoff, message.displayText), text_elements: [] }, ...message.codexInput.filter((part) => part.type === "image")] : message.codexInput,
        model,
        effort: effort || null,
        sandboxPolicy: plan ? { type: "readOnly", networkAccess: true }
          : session.controls.permissions === "full-access" ? { type: "dangerFullAccess" }
          : sandboxForIntent(route.intent, session.config.cwd),
        approvalPolicy: session.controls.permissions === "full-access" && !plan ? "never" : "on-request",
        // Send both values explicitly so switching personas cannot retain the
        // preceding turn's auto-reviewer when Default Permissions is selected.
        approvalsReviewer: persona.workMode === "auto" ? "user" : "auto_review",
        serviceTier: fast ? "fast" : "default",
        collaborationMode: {
          mode: plan ? "plan" : "default",
          settings: { model, reasoning_effort: effort || null, developer_instructions: persona.instructions || null },
        },
      }).catch((error) => {
        session.routingContext = previousContext;
        session.handoffContext = previousHandoff;
        session.deferredTurns = [];
        throw error;
      });
      if (session.closed) return;
      session.lastProvider = "codex";
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
      this.emitTimeline(sessionId, { type: "notification", id: `auto-route:${prompt.clientMessageId}`, level: "info",
        message: executionNotice({ persona, intent: route.intent, manual, effort, fast, modeLabel, taskDepth: route.taskDepth, taskType: manual ? undefined : route.taskType, notices: route.notices }),
      });
      for (const event of session.deferredTurns.splice(0)) this.emit(event);
      // Stop can arrive before turn/start returns the ID needed by Codex.
      if (session.generation !== generation && session.activeTurnId === turnId) {
        try {
          await codex.request("turn/interrupt", { threadId: session.threadId, turnId });
        } catch (error) {
          this.emitTimeline(sessionId, { type: "notification", id: `interrupt-failed:${turnId}`, level: "error",
            message: `Could not stop the starting turn. Try Stop again. ${error instanceof Error ? error.message : String(error)}` });
        }
      }
    } catch (error) {
      this.emitPromptFailure(
        sessionId,
        prompt.clientMessageId,
        error instanceof Error ? error.message : "Could not start the Auto Mode for Paseo turn.",
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
    const hydrate = !session.contextLoaded;
    if (hydrate) session.routingContext = [];
    for (const turn of turns) {
      const items = await this.readTurnItems(codex, session.threadId, turn);
      for (const item of items) {
        if (hydrate) this.captureHistoricalContext(session, item);
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
    session.handoffContext = appendHandoff(session.handoffContext, { id, role, text });
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
      const event: ProviderEvent = {
        type: "session.turn",
        sessionId: session.id,
        turnId,
        state,
        ...(message ? { error: { message } } : {}),
      };
      if (session.starting && session.activeTurnId !== turnId) session.deferredTurns.push(event);
      else this.emit(event);
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
    if (session.closed) throw new Error("Session closed.");
    const questions = parseQuestions(request.params);
    const permissionId = "codex:" + String(request.id);
    const pending = new Promise<unknown>((resolve, reject) => {
      session.permissions.set(permissionId, { request, resolve, reject, questions });
    });
    this.emit({ type: "session.permission", sessionId: session.id, request: {
      id: permissionId, name: "request_user_input", kind: "question", title: "Questions",
      input: jsonRecord({ questions }), metadata: jsonRecord({ questions }),
      detail: { type: "plain_text", text: questions.map((question) => question.question).join("\n\n"), icon: "brain" },
    } });
    return pending;
  }

  private async requestPermission(
    session: SessionRuntime,
    request: CodexServerRequest,
  ): Promise<unknown> {
    if (request.method === "item/tool/requestUserInput" || request.method === "tool/requestUserInput") return this.requestQuestions(session, request);
    if (!isApprovalRequest(request.method)) {
      throw new Error(`Auto Mode for Paseo does not yet support '${request.method}'.`);
    }
    const permissionId = `codex:${String(request.id)}`;
    const params = asRecord(request.params) ?? {};
    const command = stringValue(params.command);
    const reason = stringValue(params.reason);
    const pending = new Promise<unknown>((resolve, reject) => {
      session.permissions.set(permissionId, { request, resolve, reject });
    });
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
    return pending;
  }

  private async respondToPermission(
    sessionId: string,
    permissionId: string,
    response: ProviderPermissionResponse,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session?.native?.hasPermission(permissionId)) {
      await session.native.respond(permissionId, response);
      return;
    }
    const pending = session?.permissions.get(permissionId);
    if (!session || !pending) {
      throw new Error(`Unknown Auto Mode for Paseo permission '${permissionId}'.`);
    }
    if (pending.questions) {
      const answers = questionAnswers(pending.questions, response);
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
    if (session) session.generation += 1;
    if (session?.native) {
      try {
        await session.native.close();
        this.emit({ type: "request.completed", requestId });
      } catch (error) {
        this.emit({ type: "request.failed", requestId, error: { message: String(error) } });
      }
      return;
    }
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
      pending.reject(new Error("Auto Mode for Paseo session closed."));
    }
    session.permissions.clear();
    await Promise.all([session.codex?.close(), session.native?.close()]);
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
  const personas = settings.personas.filter((persona) => persona.enabled);
  return [autoModel(), ...personas.map((persona) => ({
    id: persona.id, label: persona.name, description: persona.description, isDefault: false,
  }))];
}

async function normalizePersonaSelection(value: string): Promise<string> {
  if (value === "auto-jev-codex-for-paseo" || value === MODEL_ID) return MODEL_ID;
  const settings = await loadSettings();
  const direct = settings.personas.find((persona) => persona.id === value);
  if (direct) return direct.id;
  const legacy = settings.personas.find((persona) => persona.model === value);
  return legacy?.id ?? value;
}

function autoModel() {
  return {
    id: MODEL_ID,
    label: "Auto Mode for Paseo",
    description: "The classifier chooses a configured persona before every new turn.",
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

function prepareComposerMessage(content: ComposerMessageContent): PreparedComposerMessage {
  const text = messageText(content);
  const images = content.filter((part): part is ComposerImageContent => part.type === "image");
  if (!text && images.length === 0) {
    throw new Error("Add a message or an image before sending.");
  }
  if (images.length > MAX_IMAGES_PER_MESSAGE) {
    throw new Error(`Auto Mode for Paseo supports up to ${MAX_IMAGES_PER_MESSAGE} images per message.`);
  }

  const codexInput: CodexTurnInput[] = text
    ? [{ type: "text", text, text_elements: [] }]
    : [];
  for (const [index, image] of images.entries()) {
    codexInput.push(toCodexImageInput(image, index + 1));
  }

  const imageDescription = images.length === 1 ? "1 image attached." : `${images.length} images attached.`;
  return {
    displayText: text || `[${imageDescription}]`,
    // The classifier processes the message text. Image bytes stay local to Codex.
    routeText: text || "Analyze the attached image.",
    contextText: text ? `${text}\n[${imageDescription}]` : imageDescription,
    codexInput,
  };
}

function toCodexImageInput(image: ComposerImageContent, index: number): CodexTurnInput {
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(image.mimeType)) {
    throw new Error(`Image ${index} has unsupported type '${image.mimeType}'. Use PNG, JPEG, WebP, or GIF.`);
  }
  if (image.data.length > MAX_IMAGE_BASE64_LENGTH) {
    throw new Error(`Image ${index} exceeds the ${MAX_IMAGE_BYTES_PER_IMAGE / 1024 / 1024} MiB limit.`);
  }
  const byteLength = base64ByteLength(image.data, index);
  if (byteLength > MAX_IMAGE_BYTES_PER_IMAGE) {
    throw new Error(`Image ${index} exceeds the ${MAX_IMAGE_BYTES_PER_IMAGE / 1024 / 1024} MiB limit.`);
  }

  return { type: "image", url: `data:${image.mimeType};base64,${image.data}` };
}

function base64ByteLength(data: string, imageIndex: number): number {
  if (!data || data.length % 4 !== 0) {
    throw new Error(`Image ${imageIndex} is not valid Base64 image data.`);
  }
  const firstPadding = data.indexOf("=");
  const padding = firstPadding < 0 ? 0 : data.length - firstPadding;
  if (padding > 2 || (padding > 0 && firstPadding !== data.length - padding)) {
    throw new Error(`Image ${imageIndex} is not valid Base64 image data.`);
  }
  const dataLength = data.length - padding;
  for (let offset = 0; offset < dataLength; offset += 1) {
    const code = data.charCodeAt(offset);
    const valid = (code >= 48 && code <= 57)
      || (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || code === 43
      || code === 47;
    if (!valid) throw new Error(`Image ${imageIndex} is not valid Base64 image data.`);
  }
  return (data.length / 4) * 3 - padding;
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
    threadId: session.threadId, routingContext: session.routingContext, handoffContext: session.handoffContext, lastProvider: session.lastProvider,
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
