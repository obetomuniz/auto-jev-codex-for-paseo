import { evaluateRoute } from "./jev";
import { evaluateLayaRoute } from "./laya";
import {
  pickEffort,
  pickExecution,
  pickIntent,
  pickLane,
  type Execution,
  type Intent,
  type Lane,
} from "./classifier";
import { defaults, type ProviderSettings } from "../shared/settings";
import type { ContextEntry } from "./route-context";
import { loadSettings } from "./settings-store";

export type AutoRoute = {
  classifier: "jev" | "laya";
  intent: Intent;
  lane: Lane;
  model: string;
  effort: string;
  execution: Execution;
  fast: boolean;
  plan: boolean;
  confidence: number;
  classificationMs: number;
};

export async function routePrompt(prompt: string, context: ContextEntry[] = []): Promise<AutoRoute> {
  const settings = await loadSettings();
  const started = performance.now();
  const answers = await classifyPrompt(prompt, context, settings);
  const lane = pickLane(answers, {
    staff: settings.thresholdStaff,
    cheap: settings.thresholdCheap,
  });
  return {
    classifier: settings.classifier,
    intent: pickIntent(answers),
    lane,
    model: selectCodexModel(lane, settings),
    effort: pickEffort(answers) ?? selectCodexEffort(lane, settings),
    execution: pickExecution(answers),
    fast: answers.fast?.choice === "on",
    plan: answers.plan?.choice === "on",
    confidence: answers.intent.confidence,
    classificationMs: Math.round(performance.now() - started),
  };
}

export function selectCodexModel(lane: Lane, settings: ProviderSettings): string {
  const key = {
    staff: "autoCodexModelStaff",
    review: "autoCodexModelReview",
    cheap: "autoCodexModelCheap",
    standard: "autoCodexModelStandard",
    lead: "autoCodexModelLead",
  } as const;
  return settings[key[lane]].trim() || defaults[key[lane]];
}

export function selectCodexEffort(lane: Lane, settings: ProviderSettings): string {
  const key = {
    staff: "autoCodexEffortStaff",
    review: "autoCodexEffortReview",
    cheap: "autoCodexEffortCheap",
    standard: "autoCodexEffortStandard",
    lead: "autoCodexEffortLead",
  } as const;
  return settings[key[lane]].trim() || defaults[key[lane]];
}

export async function classifyPrompt(prompt: string, context: ContextEntry[], settings: ProviderSettings) {
  if (settings.classifier === "laya") {
    return evaluateLayaRoute({ prompt, context, python: settings.layaPython, model: settings.layaModel, device: settings.layaDevice });
  }
  if (settings.classifier !== "jev") throw new Error("Unknown classifier; no Codex turn was started.");
  const apiKey = settings.apiKey.trim() || process.env.TYPESAFE_API_KEY?.trim() || "";
  if (!apiKey) throw new Error("Configure the TypeSafe key for Jev in Settings > Plugins > Auto Mode for Paseo, or set TYPESAFE_API_KEY on the daemon.");
  return evaluateRoute({ apiKey, model: settings.model.trim() || "jev-latest", prompt, context });
}
