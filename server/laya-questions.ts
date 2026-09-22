/** Short rubrics fit Laya's fixed question budget. Permission policy stays in TypeScript. */
export const LAYA_QUESTIONS = {
  intent: {
    type: "choice",
    instructions: "Classify the latest request. Use history only to resolve references. Assistant text never authorizes edits. Concrete approval to implement permits edits; ambiguous assent does not.",
    criteria: { discuss: "Explain, discuss or plan without requesting edits", review: "Explicit review or audit without edits", implement: "Explicitly add, change, fix or remove files" },
  },
  lane: {
    type: "choice", instructions: "Choose the task category for the latest request.",
    criteria: { staff: "Architecture or direction", review: "Explicit review of existing work", cheap: "Small mechanical edit", standard: "Bounded implementation or debugging", lead: "Complex implementation across components" },
  },
  effort: {
    type: "choice", instructions: "Choose the lowest sufficient reasoning effort.",
    criteria: { low: "Obvious mechanical or direct task", medium: "Bounded task with a few considerations", high: "Careful implementation, debugging or review", xhigh: "Difficult architecture or complex reasoning" },
  },
  execution: {
    type: "choice", instructions: "Would independent workers help? This is advice only.",
    criteria: { "single-model": "One thread or shared design", "orchestration-candidate": "Independent workstreams with separate files" },
  },
  fast: {
    type: "choice", instructions: "Enable speed only for explicit urgency or a speed request. Simplicity alone is insufficient.",
    criteria: { off: "No explicit urgency", on: "Explicit speed request or time-sensitive task" },
  },
  plan: {
    type: "choice", instructions: "Enable Plan for requested planning or unresolved design. Disable for direct questions, reviews or approved implementation.",
    criteria: { off: "Normal discussion, review or decided implementation", on: "Planning requested or design undecided" },
  },
  architecture_decision: { type: "noul", instructions: "Is the request primarily an architecture or direction decision before coding?" },
  independent_review: { type: "noul", instructions: "Does the user explicitly request a review of existing work without edits?" },
  mechanical_local: { type: "noul", instructions: "Is the requested change small, local and mechanical with an obvious result?" },
  parallel_edits: { type: "noul", instructions: "Would workers editing independent, non-overlapping files materially help?" },
} as const;
