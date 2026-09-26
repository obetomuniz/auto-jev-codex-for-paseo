import { randomUUID } from "node:crypto";
import type { PaseoApi, PaseoAgentHandle, PaseoAgentTimelineEvent } from "@getpaseo/client";
import {
  ProviderEventSchema,
  type ProviderEvent,
  type ProviderPermissionResponse,
  type ProviderSessionConfig,
} from "@getpaseo/plugin/server/provider";
import type { Preset } from "../shared/settings";
import { nativePolicy, type ExecutionPolicy } from "./provider-policy";
import { handoffPrompt } from "./handoff";
import type { ContextEntry } from "./route-context";
import { executionNotice } from "./execution-notice";
import type { TaskDepth } from "../shared/task-depth";
import type { TaskType } from "../shared/task-types";

export type PaseoAccess = () => PaseoApi;

/** One native Paseo run. Paseo owns credentials, provider processes and history. */
export class PaseoExecution {
  readonly turnId = `paseo:${randomUUID()}`;
  private agent: PaseoAgentHandle | undefined;
  private unsubscribe: (() => void) | undefined;
  private canceled = false;
  private terminal = false;
  private announced = false;
  private readonly earlyEvents: ProviderEvent[] = [];
  private readonly permissions = new Map<string, string>();
  private sequence = 0;
  private archivePromise: Promise<unknown> | undefined;

  constructor(
    private readonly paseo: PaseoApi,
    private readonly sessionId: string,
    private readonly emit: (event: ProviderEvent) => void,
  ) {}

  async start(input: {
    config: ProviderSessionConfig;
    preset: Preset;
    manual?: boolean;
    taskDepth?: TaskDepth;
  taskType?: TaskType;
    notices?: string[];
    policy: ExecutionPolicy;
    context: ContextEntry[];
    text: string;
    images: Array<{ data: string; mimeType: string }>;
    clientMessageId: string;
    accepted(): void;
  }): Promise<void> {
    const { preset, policy, config } = input;
    const [models, modes] = await Promise.all([
      this.paseo.providers.listModels(preset.provider, { cwd: config.cwd }),
      this.paseo.providers.listModes(preset.provider, { cwd: config.cwd }).catch(() => ({ modes: [] })),
    ]);
    if (models.error) throw new Error(models.error);
    const safety = nativePolicy(policy, "error" in modes && modes.error ? [] : modes.modes ?? [], preset.workMode);
    const model = models.models?.find((item) => item.id === preset.model && item.isSelectable !== false);
    if (!model) throw new Error(`Model '${preset.model}' is not available from '${preset.provider}'. Update this preset in the plugin settings.`);
    const effort = model.thinkingOptions?.some((option) => option.id === preset.effort) ? preset.effort : undefined;
    const notices = [...safety.notices];
    if (preset.effort && !effort) notices.push("The saved reasoning setting is unavailable; using the model default.");
    const featureValues: Record<string, boolean> = {};
    const features = await this.paseo.providers.listFeatures({ provider: `${preset.provider}/${preset.model}`, cwd: config.cwd, modeId: safety.modeId })
      .catch(() => ({ features: [] }));
    const fast = "error" in features && features.error ? undefined : features.features?.find((feature) => feature.type === "toggle" && ["fast_mode", "fast"].includes(feature.id));
    if (fast) featureValues[fast.id] = policy.fast;
    else if (policy.fast) notices.push("Fast is unavailable for this model; using its normal speed.");
    if (this.canceled) throw new Error("Turn canceled before provider startup.");
    this.agent = await this.paseo.agents.create({
      cwd: config.cwd,
      env: { ...config.env },
      title: `${preset.name} · Auto Mode`,
      labels: { "auto-mode-session": this.sessionId },
      config: {
        provider: `${preset.provider}/${preset.model}`,
        ...(safety.modeId ? { modeId: safety.modeId } : {}),
        ...(effort ? { thinkingOptionId: effort } : {}),
        featureValues,
        options: safety.options,
        systemPrompt: [config.systemPrompt, preset.instructions,
          "Complete the requested task before sending the final response. Progress updates do not end the task.",
          ...(safety.analysisOnly ? [`This request is for ${safety.planning ? "planning" : policy.intent}. Analyze and report without modifying workspace files or taking external actions. Ask the user before moving to implementation.`] : []),
        ].filter(Boolean).join("\n\n"),
        mcpServers: { ...config.mcpServers },
        toolPolicy: config.toolPolicy,
      },
    });
    if (this.canceled) {
      await this.archive();
      throw new Error("Turn canceled during provider startup.");
    }
    try {
      const subscription = this.agent.timeline.subscribe((event) => this.receive(event));
      this.unsubscribe = subscription;
      await subscription.ready;
      if (this.canceled) throw new Error("Turn canceled before prompt delivery.");
      if (this.terminal) throw new Error("Provider stopped before prompt delivery. No prompt was sent. Retry the message.");
      await this.agent.send(handoffPrompt(input.context, input.text), { messageId: input.clientMessageId, images: input.images });
      if (this.canceled) throw new Error("Turn canceled during prompt delivery.");
      input.accepted();
      this.emit({ type: "session.prompt_result", sessionId: this.sessionId, clientMessageId: input.clientMessageId, result: { type: "turn", turnId: this.turnId } });
      this.emit({ type: "session.turn", sessionId: this.sessionId, turnId: this.turnId, state: "started" });
      this.announced = true;
      this.emit({ type: "timeline.item", sessionId: this.sessionId, item: { type: "notification", id: `${this.turnId}:setup`, level: "info",
        message: executionNotice({ preset, intent: policy.intent, manual: input.manual, modelLabel: model.label, taskDepth: input.taskDepth, taskType: input.taskType,
          modeLabel: safety.modeLabel, effort, fast: fast ? featureValues[fast.id] : false, notices: [...(input.notices ?? []), ...notices] }),
      } });
      for (const event of this.earlyEvents.splice(0)) this.emit(event);
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  hasPermission(id: string): boolean { return this.permissions.has(id); }

  async respond(id: string, response: ProviderPermissionResponse): Promise<void> {
    const nativeId = this.permissions.get(id);
    if (!this.agent || !nativeId) throw new Error("This provider question or permission is no longer pending.");
    await this.agent.respondToPermission({ requestId: nativeId, response });
    if (this.permissions.delete(id)) this.publish({ type: "session.permission_resolved", sessionId: this.sessionId, permissionId: id });
  }

  async close(): Promise<void> {
    this.canceled = true;
    try { await this.archive(); }
    catch (error) {
      // A failed Stop does not prove the provider stopped. Keep observing it.
      // Startup cancellation still blocks prompt delivery even if cleanup fails.
      if (this.announced && !this.terminal) this.canceled = false;
      throw error;
    }
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.announced && !this.terminal) this.finish("canceled");
    this.clearPermissions();
  }

  private receive(payload: PaseoAgentTimelineEvent): void {
    if (this.terminal || (this.canceled && !this.announced)) return;
    const event = payload.event;
    try {
      if (event.type === "timeline") {
        if (event.item.type === "user_message") return;
        const id = `paseo:${payload.agentId}:${"epoch" in payload ? payload.epoch ?? "" : ""}:${"seq" in payload && payload.seq !== undefined ? payload.seq : ++this.sequence}`;
        const mapped = ProviderEventSchema.parse({ type: "timeline.item", sessionId: this.sessionId, item: { ...event.item, id } });
        this.publish(mapped);
      } else if (event.type === "permission_requested") {
        const id = `paseo:${payload.agentId}:${event.request.id}`;
        const mapped = ProviderEventSchema.parse({ type: "session.permission", sessionId: this.sessionId, request: { ...event.request, id } });
        this.permissions.set(id, event.request.id);
        this.publish(mapped);
      } else if (event.type === "permission_resolved") {
        const permissionId = `paseo:${payload.agentId}:${event.requestId}`;
        if (this.permissions.delete(permissionId)) this.publish({ type: "session.permission_resolved", sessionId: this.sessionId, permissionId });
      } else if (event.type === "turn_completed") {
        this.finish("completed");
      } else if (event.type === "turn_failed") {
        this.finish("failed", event.error);
      } else if (event.type === "turn_canceled") {
        this.finish("canceled");
      } else if (event.type === "replacement") {
        this.finish("failed", "Provider connection changed during the turn. Retry the message after reconnecting.");
      }
    } catch (error) {
      this.finish("failed", error instanceof Error ? error.message : "Invalid provider event.");
    }
  }

  private finish(state: "completed" | "failed" | "canceled", message?: string): void {
    if (this.terminal) return;
    this.terminal = true;
    this.clearPermissions();
    this.publish({ type: "session.turn", sessionId: this.sessionId, turnId: this.turnId, state, ...(message ? { error: { message } } : {}) });
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    void this.archive().catch((error: unknown) => this.publish({ type: "timeline.item", sessionId: this.sessionId,
      item: { type: "notification", id: `${this.turnId}:cleanup`, level: "warning", message: `Could not archive the native provider run: ${String(error)}` },
    }));
  }

  private clearPermissions(): void {
    for (const permissionId of this.permissions.keys()) this.publish({ type: "session.permission_resolved", sessionId: this.sessionId, permissionId });
    this.permissions.clear();
  }

  private archive(): Promise<unknown> {
    if (!this.agent) return Promise.resolve();
    this.archivePromise ??= this.agent.archive().catch((error: unknown) => { this.archivePromise = undefined; throw error; });
    return this.archivePromise;
  }

  private publish(event: ProviderEvent): void {
    if (this.announced) this.emit(event);
    else this.earlyEvents.push(event);
  }
}
