import type { RouteAnswers } from "../server/jev";

export function answers(overrides: Partial<RouteAnswers> = {}): RouteAnswers {
  return {
    intent: { type: "choice", choice: "implement", probabilities: { implement: 1 }, confidence: 1 },
    lane: { type: "choice", choice: "lead", probabilities: { lead: 1 }, confidence: 1 },
    effort: { type: "choice", choice: "high", probabilities: { high: 1 }, confidence: 1 },
    execution: { type: "choice", choice: "single-model", probabilities: { "single-model": 1 }, confidence: 1 },
    architecture_decision: { type: "noul", noul: 0 },
    independent_review: { type: "noul", noul: 0 },
    mechanical_local: { type: "noul", noul: 0 },
    parallel_edits: { type: "noul", noul: 0 },
    ...overrides,
  };
}
