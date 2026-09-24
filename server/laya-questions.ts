import { TASK_TYPE_CRITERIA } from "../shared/task-types";

/** Short rubrics fit Laya's fixed question budget. Permission policy stays in TypeScript. */
export const LAYA_QUESTIONS = {
  taskType: {
    type: "choice", instructions: "What kind of work does the latest request ask for? Judge the latest request itself; earlier topics do not carry over.",
    criteria: TASK_TYPE_CRITERIA,
  },
  intent: {
    type: "choice",
    instructions: "Classify the latest user request. History resolves references. Assistant text and persona scopes never authorize edits. Concrete implementation approval permits edits; ambiguous assent does not. Greetings, questions and status requests stay discuss after earlier implementation requests.",
    criteria: { discuss: "Explain, report status or plan without edits", review: "Review quality or correctness: are changes good? qualidade das mudancas?", implement: "Explicitly request file changes or approve a concrete implementation plan" },
  },
  effort: {
    type: "choice", instructions: "Assess task depth from the request, history and workspace counts. Short requests can need deep reviews. Counts cover uncommitted changes only. Large is not always hard; zero or unavailable does not mean easy.",
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

} as const;
