import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const settingsSchema = z.object({
  classifier: z.enum(["jev", "laya"]).default("jev"),
  layaPython: z.string().trim().min(1).default("python"),
  layaCache: z.string().trim().default(""),
  layaModel: z.enum(["multilingual", "english", "typed-decisions"]).default("multilingual"),
  layaDevice: z.enum(["cpu", "cuda", "auto"]).default("cpu"),
  apiKey: z.string().default(""),
  model: z.string().default("jev-latest"),
  thresholdStaff: z.number().min(0).max(1).default(0.7),
  thresholdCheap: z.number().min(0).max(1).default(0.8),
  autoCodexModelStaff: z.string().default("gpt-6-astra"),
  autoCodexModelReview: z.string().default("gpt-6-astra"),
  autoCodexModelCheap: z.string().default("gpt-5.6-luna"),
  autoCodexModelStandard: z.string().default("gpt-5.6-terra"),
  autoCodexModelLead: z.string().default("gpt-5.6-sol"),
  autoCodexEffortStaff: z.string().default("xhigh"),
  autoCodexEffortReview: z.string().default("xhigh"),
  autoCodexEffortCheap: z.string().default("low"),
  autoCodexEffortStandard: z.string().default("medium"),
  autoCodexEffortLead: z.string().default("high"),
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
