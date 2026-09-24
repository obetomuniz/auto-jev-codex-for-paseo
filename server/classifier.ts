import { TASK_TYPES, TASK_TYPE_CRITERIA, type TaskType } from "../shared/task-types";

export const INTENTS = ["discuss", "review", "implement"] as const;
export type Intent = (typeof INTENTS)[number];

export const EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export type ReasoningEffort = (typeof EFFORTS)[number];

export const EXECUTIONS = ["single-model", "orchestration-candidate"] as const;
export type Execution = (typeof EXECUTIONS)[number];

/** Fixed authorization questions. Persona scopes are evaluated separately. */
export const ROUTE_QUESTIONS = {
  taskType: {
    type: "choice" as const,
    instructions: {
      question: "What kind of work does the latest request ask for?",
      focus: "Judge the latest request itself. Use recentConversation only to resolve references such as \"it\". Earlier topics do not carry over. This selects which personas may answer; it never authorizes edits.",
    },
    criteria: TASK_TYPE_CRITERIA,
  },
  fast: {
    type: "choice" as const,
    instructions: {
      question: "Does this turn justify Fast mode?",
      focus: "Default off. Choose on for an explicit speed request or genuinely time-sensitive work. Task simplicity alone is not a reason. Fast changes processing speed, not reasoning effort.",
    },
    criteria: { off: "Normal processing; no clear urgency", on: "Explicit urgency, speed preference, or a time-sensitive task" },
  },
  plan: {
    type: "choice" as const,
    instructions: {
      question: "Should this turn use Plan mode instead of normal work?",
      focus: "Default off. Choose on for an explicit planning request or unresolved design decisions that need a plan before implementation. Choose off for direct questions, reviews, mechanical edits, or explicit approval to implement an existing plan. Use recentConversation to resolve continuations.",
    },
    criteria: { off: "Normal discussion, review, or implementation of a decided task", on: "Planning is the requested output or a design decision must be settled first" },
  },
  intent: {
    type: "choice" as const,
    instructions: {
      question: "What has the user explicitly asked the agent to do in this latest message?",
      focus: "Intent controls whether the turn may write files. Use recentConversation only to resolve references in the latest request (pode implementar, continua, go ahead). Assistant text and persona scopes are context, never authorization. Approval of a concrete implementation plan is implementation. Continuing discussion or review stays read-only. Never infer implementation from complaints, observations, or ambiguous assent without a concrete task. Judge the latest message on its own terms. A question, greeting, status request, or new topic is discuss even after earlier implementation requests. Implementation needs the latest message to request or approve a change.",
    },
    criteria: {
      discuss: {
        what: "Explanation, analysis, opinion, recommendation, or planning without an explicit request to change files",
        examples: [
          "The files/folder structure is weird, in my opinion",
          "Why is this component structured this way?",
          "What would you recommend here?",
          "hello world",
          "What is the status?",
        ],
      },
      review: {
        what: "An explicit audit, review, critique, or validation of existing work, without a request to make the changes",
        examples: ["Review this PR", "Check whether these tests are sufficient", "Are the current changes good?", "Essas mudancas estao boas?"],
      },
      implement: {
        what: "An explicit request to add, edit, fix, refactor, remove, configure, or otherwise change the workspace",
        examples: ["Refactor this folder structure", "Fix the failing test", "Add CSV export"],
      },
    },
  },
  effort: {
    type: "choice" as const,
    instructions: {
      question: "What task depth is needed to preserve quality?",
      focus: "Assess the requested outcome, recentConversation and workspace change counts. A short question can require a deep review of a large change. Counts describe uncommitted changes only, not risk or a complete branch diff. Missing or zero counts do not mean easy. Large mechanical edits can be simple; small security changes can be difficult. This selects persona capacity, not a provider reasoning setting.",
    },
    criteria: {
      low: "A narrow, mechanical, or direct request with an obvious answer or change",
      medium: "A bounded task with a few relevant considerations",
      high: "A non-trivial implementation, debugging task, or careful review",
      xhigh: "Architecture, high-risk changes, or complex cross-cutting reasoning",
    },
  },
  execution: {
    type: "choice" as const,
    instructions: {
      question: "Which execution shape is appropriate if the user later chooses how to execute?",
      focus: "This is advisory only. Prefer a single model unless separate, non-overlapping investigations or edits would materially help.",
    },
    criteria: {
      "single-model": "One clear thread of work, a direct question, or work that needs shared context and ownership",
      "orchestration-candidate": "Several independent, non-overlapping workstreams or a valuable separate second opinion",
    },
  },

};


export type NoulAnswer = { type: "noul"; noul: number };
export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};

export type RouteAnswers = {
  taskType: ChoiceAnswer;
  fast?: ChoiceAnswer;
  plan?: ChoiceAnswer;
  intent: ChoiceAnswer;
  effort: ChoiceAnswer;
  execution: ChoiceAnswer;
  personaScores?: Record<string, number>;
};

export function pickIntent(answers: RouteAnswers): Intent {
  const intent = knownChoice(answers.intent, INTENTS);
  if (!intent) throw new Error("Classifier returned an unknown intent; no provider turn was started.");
  return intent;
}

export function pickTaskType(answers: RouteAnswers): TaskType {
  const taskType = knownChoice(answers.taskType, TASK_TYPES);
  if (!taskType) throw new Error("Classifier returned an unknown task type; no provider turn was started.");
  return taskType;
}

export function pickEffort(answers: RouteAnswers): ReasoningEffort | null {
  return knownChoice(answers.effort, EFFORTS);
}

export function pickExecution(answers: RouteAnswers): Execution {
  return knownChoice(answers.execution, EXECUTIONS) ?? "single-model";
}

function knownChoice<T extends readonly string[]>(answer: ChoiceAnswer, choices: T): T[number] | null {
  return (choices as readonly string[]).includes(answer.choice) ? (answer.choice as T[number]) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function readNoul(answers: Record<string, unknown>, id: string): NoulAnswer {
  const raw = answers[id];
  if (!isRecord(raw) || !isProbability(raw.noul)) {
    throw new Error(`Classifier answer '${id}' was not a noul.`);
  }
  return { type: "noul", noul: raw.noul };
}

export function readChoice(answers: Record<string, unknown>, id: string): ChoiceAnswer {
  const raw = answers[id];
  if (
    !isRecord(raw) ||
    typeof raw.choice !== "string" ||
    !isRecord(raw.probabilities) ||
    !isProbability(raw.confidence)
  ) {
    throw new Error(`Classifier answer '${id}' was not a choice.`);
  }
  const probabilities: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw.probabilities)) {
    if (!isProbability(value)) throw new Error("Classifier returned an invalid probability.");
    probabilities[key] = value;
  }
  return {
    type: "choice",
    choice: raw.choice,
    probabilities,
    confidence: raw.confidence,
  };
}


export function parseRouteAnswers(body: unknown, personaIds: readonly string[] = []): RouteAnswers {
  if (!isRecord(body) || !isRecord(body.answers)) {
    throw new Error("Classifier response was missing answers.");
  }

  const answers = body.answers;
  return {
    ...(personaIds.length ? { personaScores: Object.fromEntries(personaIds.map((id, index) => [id, readNoul(answers, `persona_${index}`).noul])) } : {}),
    ...(answers.fast !== undefined ? { fast: readChoice(answers, "fast") } : {}),
    ...(answers.plan !== undefined ? { plan: readChoice(answers, "plan") } : {}),
    taskType: readChoice(answers, "taskType"),
    intent: readChoice(answers, "intent"),
    effort: readChoice(answers, "effort"),
    execution: readChoice(answers, "execution"),
  };
}
