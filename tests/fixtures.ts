import type { RouteAnswers } from "../server/classifier";
import { defaults, type Preset } from "../shared/settings";
import { presetQuestions } from "../server/preset-classification";

export function answers(overrides: Partial<RouteAnswers> = {}): RouteAnswers {
  const review = overrides.intent?.choice === "review";
  return {
    taskType: { type: "choice", choice: review ? "review" : "implement", probabilities: { [review ? "review" : "implement"]: 1 }, confidence: 1 },
    intent: { type: "choice", choice: "implement", probabilities: { implement: 1 }, confidence: 1 },
    effort: { type: "choice", choice: "high", probabilities: { high: 1 }, confidence: 1 },
    execution: { type: "choice", choice: "single-model", probabilities: { "single-model": 1 }, confidence: 1 },
    presetScores: Object.fromEntries(defaults.presets.map((preset) => [preset.id, preset.id === (overrides.intent?.choice === "review" ? "critic" : "tech-lead") ? 0.95 : 0.05])),
    ...overrides,
  };
}

export function wireAnswers(result = answers(), presets: readonly Preset[] = defaults.presets) {
  const { presetScores, ...rest } = result;
  return { ...rest, ...Object.fromEntries(presetQuestions(presets).ids.map((id, index) => [`preset_${index}`, { type: "noul", noul: presetScores?.[id] ?? 0 }])) };
}
