import type { RouteAnswers } from "../server/classifier";
import { defaults, type Persona } from "../shared/settings";
import { personaQuestions } from "../server/persona-classification";

export function answers(overrides: Partial<RouteAnswers> = {}): RouteAnswers {
  const review = overrides.intent?.choice === "review";
  return {
    taskType: { type: "choice", choice: review ? "review" : "implement", probabilities: { [review ? "review" : "implement"]: 1 }, confidence: 1 },
    intent: { type: "choice", choice: "implement", probabilities: { implement: 1 }, confidence: 1 },
    effort: { type: "choice", choice: "high", probabilities: { high: 1 }, confidence: 1 },
    execution: { type: "choice", choice: "single-model", probabilities: { "single-model": 1 }, confidence: 1 },
    personaScores: Object.fromEntries(defaults.personas.map((persona) => [persona.id, persona.id === (overrides.intent?.choice === "review" ? "critic" : "tech-lead") ? 0.95 : 0.05])),
    ...overrides,
  };
}

export function wireAnswers(result = answers(), personas: readonly Persona[] = defaults.personas) {
  const { personaScores, ...rest } = result;
  return { ...rest, ...Object.fromEntries(personaQuestions(personas).ids.map((id, index) => [`persona_${index}`, { type: "noul", noul: personaScores?.[id] ?? 0 }])) };
}
