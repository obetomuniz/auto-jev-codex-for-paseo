import {
  evaluateRoute,
  pickEffort,
  pickExecution,
  pickIntent,
  pickLane,
  type Execution,
  type Intent,
  type Lane,
} from "./jev";
import { defaults, type ProviderSettings } from "../shared/settings";
import type { ContextEntry } from "./route-context";
import { loadSettings } from "./settings-store";

export type AutoJevRoute = {
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

export async function routePromptWithJev(prompt: string, context: ContextEntry[] = []): Promise<AutoJevRoute> {
  const settings = await loadSettings();
  const apiKey = settings.apiKey.trim() || process.env.TYPESAFE_API_KEY?.trim() || "";
  if (!apiKey) {
    throw new Error(
      "Configure the TypeSafe key in Settings > Plugins > Auto Jev-Codex for Paseo, or set TYPESAFE_API_KEY on the daemon.",
    );
  }

  const started = performance.now();
  const answers = await evaluateRoute({
    apiKey,
    model: settings.model.trim() || "jev-latest",
    prompt,
    context,
  });
  const lane = pickLane(answers, {
    staff: settings.thresholdStaff,
    cheap: settings.thresholdCheap,
  });
  return {
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
