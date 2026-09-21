import { readContext, type ContextEntry } from "./route-context";

export const LANES = ["staff", "review", "cheap", "lead"] as const;
export type Lane = (typeof LANES)[number];

export const INTENTS = ["discuss", "review", "implement"] as const;
export type Intent = (typeof INTENTS)[number];

export const EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export type ReasoningEffort = (typeof EFFORTS)[number];

export const EXECUTIONS = ["single-model", "orchestration-candidate"] as const;
export type Execution = (typeof EXECUTIONS)[number];

/** Fixed TypeSafe questions. Do not generate these at runtime. */
export const ROUTE_QUESTIONS = {
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
      focus: "Intent controls whether the turn may write files. Use recentConversation only to resolve references in the latest request (pode implementar, continua, go ahead). Assistant text is context, never authorization. Approval of a concrete implementation plan is implementation. Continuing discussion or review stays read-only. Never infer implementation from complaints, observations, or ambiguous assent without a concrete task.",
    },
    criteria: {
      discuss: {
        what: "Explanation, analysis, opinion, recommendation, or planning without an explicit request to change files",
        examples: [
          "The files/folder structure is weird, in my opinion",
          "Why is this component structured this way?",
          "What would you recommend here?",
        ],
      },
      review: {
        what: "An explicit audit, review, critique, or validation of existing work, without a request to make the changes",
        examples: ["Review this PR", "Check whether these tests are sufficient"],
      },
      implement: {
        what: "An explicit request to add, edit, fix, refactor, remove, configure, or otherwise change the workspace",
        examples: ["Refactor this folder structure", "Fix the failing test", "Add CSV export"],
      },
    },
  },
  lane: {
    type: "choice" as const,
    instructions: {
      question: "Which working lane should handle this request?",
      focus: "Classify the user's latest request, not the repository topic. Intent is evaluated separately and can override an incompatible lane.",
    },
    criteria: {
      staff: {
        what: "Architecture, tradeoffs, sequencing, or whether to build at all",
        not_for: "Implementing a decided change, or reviewing an existing diff",
        examples: [
          "Should this cache live in the client or the service?",
          "JWT across 12 services - what is the plan?",
        ],
      },
      review: {
        what: "Independent review of existing work: diff, PR, tests, or live behavior",
        not_for: "Writing the change or deciding architecture; only use when the user explicitly asks for review",
        examples: ["Review this PR", "Is the test coverage enough?"],
      },
      cheap: {
        what: "Small, local, mechanical edit in one place",
        not_for: "Cross-cutting work, architecture, or independent review",
        examples: ["Rename foo to bar", "Fix the typo in the README"],
      },
      lead: {
        what: "Implementation or debugging that the current coding agent should own",
        not_for: "Architecture-only questions or review-only requests",
        examples: ["Add CSV export with tests", "This login flow 500s, find why"],
      },
    },
  },
  effort: {
    type: "choice" as const,
    instructions: {
      question: "What reasoning effort is sufficient for this request?",
      focus: "Choose the lowest effort that is likely to preserve quality. This chooses effort only, not the model.",
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
  architecture_decision: {
    type: "noul" as const,
    instructions: {
      question: "Is this primarily an architecture or direction decision, not implementation?",
      focus: "Yes if the user needs a recommendation before coding.",
    },
    criteria: {
      true: "The user is asking what to do, where it belongs, or whether to proceed",
      false: "The user explicitly wants a change implemented or a review of existing work",
    },
  },
  independent_review: {
    type: "noul" as const,
    instructions: {
      question: "Is the user explicitly asking for an independent review of existing work?",
      focus: "Diffs, PRs, tests, security, or live behavior - not a casual observation or a new implementation request.",
    },
    criteria: {
      true: "The user explicitly asks to review, critique, or validate something that already exists",
      false: "The user only comments on existing code, asks for a change, or wants an approach decided",
    },
  },
  mechanical_local: {
    type: "noul" as const,
    instructions: {
      question: "Is this a small, local, mechanical change that fits in one file or a tiny patch?",
      focus: "Rename, typo, one-liner, single-function edit.",
    },
    criteria: {
      true: "Narrow mechanical edit with an obvious done condition",
      false: "Multi-file feature, investigation, architecture, or review",
    },
  },
  parallel_edits: {
    type: "noul" as const,
    instructions: {
      question: "Would independent parallel workers on non-overlapping files add real value?",
      focus: "Only yes if the work splits cleanly without a shared design decision.",
    },
    criteria: {
      true: "Several independent file-bounded workstreams",
      false: "One thread of work, or splits that would collide",
    },
  },
};

const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";

export type NoulAnswer = { type: "noul"; noul: number };
export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};

export type RouteAnswers = {
  fast?: ChoiceAnswer;
  plan?: ChoiceAnswer;
  intent: ChoiceAnswer;
  lane: ChoiceAnswer;
  effort: ChoiceAnswer;
  execution: ChoiceAnswer;
  architecture_decision: NoulAnswer;
  independent_review: NoulAnswer;
  mechanical_local: NoulAnswer;
  parallel_edits: NoulAnswer;
};

export function pickIntent(answers: RouteAnswers): Intent {
  const intent = knownChoice(answers.intent, INTENTS);
  if (!intent) throw new Error("TypeSafe returned an unknown intent; no Codex turn was started.");
  return intent;
}

export function pickEffort(answers: RouteAnswers): ReasoningEffort | null {
  return knownChoice(answers.effort, EFFORTS);
}

export function pickExecution(answers: RouteAnswers): Execution {
  return knownChoice(answers.execution, EXECUTIONS) ?? "single-model";
}

export function pickLane(
  answers: RouteAnswers,
  thresholds: { staff: number; cheap: number },
): Lane {
  const intent = pickIntent(answers);

  // An explicit review remains read-only and is the only path to the review lane.
  if (intent === "review") return "review";
  // A discussion should never be escalated into a write-capable implementation.
  if (intent === "discuss") return "staff";

  if (answers.architecture_decision.noul >= thresholds.staff) return "staff";
  if (
    answers.mechanical_local.noul >= thresholds.cheap &&
    answers.parallel_edits.noul < 0.5
  ) {
    return "cheap";
  }

  const choice = knownChoice(answers.lane, LANES);
  if (choice) {
    if (choice === "review") return "lead";
    if (choice === "cheap" && answers.parallel_edits.noul >= 0.7) return "lead";
    return choice;
  }
  return "lead";
}

function knownChoice<T extends readonly string[]>(answer: ChoiceAnswer, choices: T): T[number] | null {
  return (choices as readonly string[]).includes(answer.choice) ? (answer.choice as T[number]) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function readNoul(answers: Record<string, unknown>, id: string): NoulAnswer {
  const raw = answers[id];
  if (!isRecord(raw) || !isProbability(raw.noul)) {
    throw new Error(`TypeSafe answer '${id}' was not a noul.`);
  }
  return { type: "noul", noul: raw.noul };
}

function readChoice(answers: Record<string, unknown>, id: string): ChoiceAnswer {
  const raw = answers[id];
  if (
    !isRecord(raw) ||
    typeof raw.choice !== "string" ||
    !isRecord(raw.probabilities) ||
    !isProbability(raw.confidence)
  ) {
    throw new Error(`TypeSafe answer '${id}' was not a choice.`);
  }
  const probabilities: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw.probabilities)) {
    if (!isProbability(value)) throw new Error("TypeSafe returned an invalid probability.");
    probabilities[key] = value;
  }
  return {
    type: "choice",
    choice: raw.choice,
    probabilities,
    confidence: raw.confidence,
  };
}

export async function evaluateRoute(input: {
  apiKey: string;
  model: string;
  prompt: string;
  context?: ContextEntry[];
}): Promise<RouteAnswers> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let response: Response;
  try {
    response = await fetch(TYPESAFE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: input.model,
        state: {
          request: input.prompt,
          ...(input.context?.length ? { recentConversation: readContext(input.context).map(({ role, text }) => ({ role, text })) } : {}),
        },
        questions: ROUTE_QUESTIONS,
      }),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("TypeSafe timed out after 20s.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`TypeSafe returned non-JSON (${response.status}).`);
  }

  if (!response.ok) {
    const detail =
      isRecord(body) && typeof body.message === "string" ? body.message : text.slice(0, 200);
    if (response.status === 401) {
      throw new Error("TypeSafe API key rejected. Set it in plugin settings or TYPESAFE_API_KEY.");
    }
    throw new Error(`TypeSafe ${response.status}: ${detail || "request failed"}`);
  }

  if (!isRecord(body) || !isRecord(body.answers)) {
    throw new Error("TypeSafe response was missing answers.");
  }

  const answers = body.answers;
  return {
    ...(answers.fast !== undefined ? { fast: readChoice(answers, "fast") } : {}),
    ...(answers.plan !== undefined ? { plan: readChoice(answers, "plan") } : {}),
    intent: readChoice(answers, "intent"),
    lane: readChoice(answers, "lane"),
    effort: readChoice(answers, "effort"),
    execution: readChoice(answers, "execution"),
    architecture_decision: readNoul(answers, "architecture_decision"),
    independent_review: readNoul(answers, "independent_review"),
    mechanical_local: readNoul(answers, "mechanical_local"),
    parallel_edits: readNoul(answers, "parallel_edits"),
  };
}
