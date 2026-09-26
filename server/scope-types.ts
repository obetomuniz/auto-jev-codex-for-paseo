import { presetSchema, type ProviderSettings } from "../shared/settings";
import { TASK_TYPES, TASK_TYPE_CRITERIA, type TaskType } from "../shared/task-types";
import { askTypeSafe, typeSafeKey } from "./jev";
import { askLaya } from "./laya";
import { readChoice } from "./classifier";

export const SCOPE_TYPE_QUESTIONS = {
  jev: {
    taskType: {
      type: "choice" as const,
      instructions: {
        question: "What kind of work does this preset scope describe?",
        focus: "The scope tells an assistant router when to use this preset. Choose the main kind of work it covers.",
      },
      criteria: TASK_TYPE_CRITERIA,
    },
  },
  laya: {
    taskType: {
      type: "choice",
      instructions: "The scope tells a router when to use this preset. What kind of work does it mainly cover?",
      criteria: TASK_TYPE_CRITERIA,
    },
  },
} as const;

/** Tags one scope with the configured classifier. Only the scope text leaves the plugin. */
export async function detectTaskTypes(description: string, settings: ProviderSettings): Promise<TaskType[]> {
  const scope = presetSchema.shape.description.parse(description);
  if (!scope) return [];
  const state = { scope };
  const body = settings.classifier === "laya"
    ? await askLaya({ python: settings.layaPython, cache: settings.layaCache, model: settings.layaModel, device: settings.layaDevice,
      state, questions: SCOPE_TYPE_QUESTIONS.laya })
    : await askTypeSafe({ apiKey: typeSafeKey(settings), model: settings.model.trim() || "jev-latest", state, questions: SCOPE_TYPE_QUESTIONS.jev });
  if (typeof body !== "object" || body === null || !("answers" in body) || typeof body.answers !== "object" || body.answers === null) {
    throw new Error("Classifier response was missing answers.");
  }
  const choice = readChoice(body.answers as Record<string, unknown>, "taskType").choice;
  if (!(TASK_TYPES as readonly string[]).includes(choice)) throw new Error("Classifier returned an unknown task type.");
  return [choice as TaskType];
}
