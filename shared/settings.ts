import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { TASK_DEPTHS } from "./task-depth";
import { TASK_TYPES } from "./task-types";

export const presetSchema = z.object({
  id: z.string().trim().regex(/^[a-z][a-z0-9-]*$/).max(80)
    .refine((id) => id !== "auto-mode-for-paseo", "This ID is reserved for Auto."),
  name: z.string().trim().min(1, "Enter a name.").max(80, "Use 80 characters or fewer."),
  description: z.string().trim().max(240, "Use 240 characters or fewer.").default(""),
  provider: z.string().trim().regex(/^[a-zA-Z0-9_-]+$/, "Choose a valid provider.").max(120, "Choose a valid provider.").default("codex")
    .refine((id) => id !== "auto-mode-for-paseo", "A preset cannot route back to Auto Mode."),
  model: z.string().trim().min(1, "Choose a model.").max(200, "Choose a valid model."),
  effort: z.string().trim().max(80, "Use 80 characters or fewer."),
  taskDepth: z.enum(TASK_DEPTHS).default("medium"),
  workMode: z.string().trim().max(200, "Choose a valid mode.").default(""),
  instructions: z.string().trim().max(8_000, "Use 8,000 characters or fewer.").default(""),
  enabled: z.boolean().default(true),
  // Auto tags are valid only for the scope they were detected from.
  taskTypes: z.array(z.enum(TASK_TYPES)).max(TASK_TYPES.length).default([])
    .refine((types) => new Set(types).size === types.length, "Choose each task type once."),
  taskTypesAuto: z.boolean().default(true),
  taskTypesScope: z.string().trim().max(240).default(""),
}).refine((preset) => preset.taskTypesAuto || preset.taskTypes.length > 0,
  { path: ["taskTypes"], message: "Choose at least one task type, or detect them from the scope." });

export type Preset = z.output<typeof presetSchema>;

const DEFAULT_TASK_TYPES: Record<string, (typeof TASK_TYPES)[number]> = {
  "tech-lead": "implement", staff: "design", critic: "review", reporter: "report", writer: "write",
};

const defaultPresets = [
  { id: "tech-lead", name: "Tech Lead", description: "Deliver requested code changes. Implement features, fix bugs, refactor code, debug failures, and add validation tests. Own implementation from investigation through verification.", provider: "codex", model: "gpt-5.6-sol", effort: "high", instructions: "Own the requested delivery. Inspect, implement, and validate a cohesive change. Scale the work to its scope and keep final accountability.", enabled: true },
  { id: "staff", name: "Staff", description: "Choose technical strategy, architecture, system boundaries, contracts, and consequential tradeoffs. Resolve design decisions and define an actionable approach before implementation.", provider: "codex", model: "gpt-6-astra", effort: "xhigh", instructions: "Clarify requirements and consequential tradeoffs. Define system boundaries and an actionable direction. Do not implement without a request.", enabled: true },
  { id: "critic", name: "Critic", description: "Review existing code, plans, tests, and behavior for quality, correctness, risks, and missing coverage. Judge whether changes are good and safe. Examples: Are these changes good? A qualidade dessas mudancas esta boa?", provider: "codex", model: "gpt-6-astra", effort: "xhigh", instructions: "Challenge existing work with evidence. Identify concrete regressions, missing coverage, and unsafe assumptions. Do not invent findings or implement fixes without a request.", enabled: true },
  { id: "reporter", name: "Reporter", description: "Report facts, progress, changes, open questions, and next steps. Summarize what changed, why it matters, what is settled, and what remains open. Answer factual questions about the current work.", provider: "codex", model: "gpt-5.6-luna", effort: "low", instructions: "Summarize what changed, why it matters, what is settled, and what remains open. Separate facts from inference. Do not turn a status report into a quality review or decision.", enabled: true },
  { id: "writer", name: "Writer", description: "Draft and edit prose: documentation, articles, explanations, release notes, and user-facing messages. Improve wording and structure for the requested audience and purpose.", provider: "codex", model: "gpt-5.6-terra", effort: "medium", instructions: "Create or improve clear prose for the requested audience and purpose. Follow the requested style. Keep claims accurate and the text focused.", enabled: true },
].map((preset) => ({ ...preset, workMode: "", taskDepth:
  preset.id === "reporter" ? "medium" as const : preset.id === "writer" ? "high" as const : "xhigh" as const,
  taskTypes: [DEFAULT_TASK_TYPES[preset.id]], taskTypesAuto: true, taskTypesScope: preset.description }));

export const MAX_PRESETS = 32;

const presetsSchema = z.array(presetSchema).max(MAX_PRESETS, `Use at most ${MAX_PRESETS} presets.`).superRefine((presets, context) => {
  const ids = new Set<string>();
  for (const [index, preset] of presets.entries()) {
    if (ids.has(preset.id)) context.addIssue({ code: "custom", path: [index, "id"], message: "Preset IDs must be unique." });
    ids.add(preset.id);
  }
});

export const settingsSchema = z.object({
  presetScopeVersion: z.literal(1).default(1),
  classifier: z.enum(["jev", "laya"]).default("jev"),
  layaPython: z.string().trim().min(1, "Enter the Python executable.").default("python"),
  layaCache: z.string().trim().default(""),
  layaModel: z.enum(["multilingual", "english", "typed-decisions"]).default("multilingual"),
  layaDevice: z.enum(["cpu", "cuda", "auto"]).default("cpu"),
  apiKey: z.string().default(""),
  model: z.string().default("jev-latest"),
  presets: presetsSchema.default(defaultPresets),
});

export type ProviderSettings = z.output<typeof settingsSchema>;

export const publicSettingsSchema = settingsSchema.omit({ apiKey: true }).extend({
  hasApiKey: z.boolean(),
});

export type PublicSettings = z.output<typeof publicSettingsSchema>;

export const defaults: ProviderSettings = settingsSchema.parse({});

export function toPublic(settings: ProviderSettings): PublicSettings {
  const { apiKey: _apiKey, ...rest } = settings;
  return publicSettingsSchema.parse({
    ...rest,
    hasApiKey: settings.apiKey.trim().length > 0,
  });
}

export const getSettingsRpc = defineRpc({
  name: "settings.get",
  input: z.object({}),
  output: publicSettingsSchema,
});

export const saveSettingsRpc = defineRpc({
  name: "settings.save",
  input: settingsSchema,
  output: publicSettingsSchema,
});
