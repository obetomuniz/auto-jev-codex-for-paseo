import { evaluateRoute, typeSafeKey } from "./jev";
import { evaluateLayaRoute } from "./laya";
import {
  pickExecution,
  pickEffort,
  pickIntent,
  pickTaskType,
  type Execution,
  type Intent,
} from "./classifier";
import { type ProviderSettings } from "../shared/settings";
import type { ContextEntry } from "./route-context";
import { loadSettings } from "./settings-store";
import { selectPersona } from "../shared/personas";
import { matchingPersona, taskTypeOwners } from "./persona-classification";
import { TASK_TYPE_LABELS, type TaskType } from "../shared/task-types";
import { depthRank, TASK_DEPTH_LABELS, type TaskDepth } from "../shared/task-depth";
import type { WorkspaceState } from "./workspace-state";

export type AutoRoute = {
  classifier: "jev" | "laya";
  intent: Intent;
  personaId: string;
  provider: string;
  instructions: string;
  model: string;
  effort: string;
  taskDepth: TaskDepth;
  taskType: TaskType;
  notices: string[];
  execution: Execution;
  fast: boolean;
  plan: boolean;
  confidence: number;
  classificationMs: number;
};

export async function routePrompt(prompt: string, context: ContextEntry[] = [], settings?: ProviderSettings, selectedId?: string, workspace?: WorkspaceState): Promise<AutoRoute> {
  settings ??= await loadSettings();
  const started = performance.now();
  const answers = await classifyPrompt(prompt, context, settings, !selectedId, workspace);
  const intent = pickIntent(answers);
  const taskDepth = pickEffort(answers);
  if (!taskDepth) throw new Error("Classifier returned an unknown task depth; no provider turn was started.");
  const taskType = pickTaskType(answers);
  const persona = selectPersona(settings, selectedId ?? matchingPersona(settings.personas, answers.personaScores, taskDepth, taskType));
  const notices = selectedId ? [] : [
    ...(taskType !== "other" && !taskTypeOwners(settings.personas, taskType).length
      ? [`No persona is assigned to ${TASK_TYPE_LABELS[taskType]} tasks. Auto used the closest scope.`] : []),
    ...(depthRank(persona.taskDepth) < depthRank(taskDepth)
      ? [`No Auto persona is configured for ${TASK_DEPTH_LABELS[taskDepth]} tasks. Using the deepest available setup (${TASK_DEPTH_LABELS[persona.taskDepth]}).`] : []),
  ];
  return {
    classifier: settings.classifier,
    intent,
    personaId: persona.id,
    provider: persona.provider,
    instructions: persona.instructions,
    model: persona.model,
    effort: persona.effort,
    taskDepth,
    taskType,
    notices,
    execution: pickExecution(answers),
    fast: answers.fast?.choice === "on",
    plan: answers.plan?.choice === "on",
    confidence: answers.intent.confidence,
    classificationMs: Math.round(performance.now() - started),
  };
}

export async function classifyPrompt(prompt: string, context: ContextEntry[], settings: ProviderSettings, automatic = true, workspace?: WorkspaceState) {
  const personas = automatic ? settings.personas : [];
  if (settings.classifier === "laya") {
    return evaluateLayaRoute({ prompt, context, personas, workspace, python: settings.layaPython, cache: settings.layaCache, model: settings.layaModel, device: settings.layaDevice });
  }
  if (settings.classifier !== "jev") throw new Error("Unknown classifier; no provider turn was started.");
  return evaluateRoute({ apiKey: typeSafeKey(settings), model: settings.model.trim() || "jev-latest", prompt, context, personas, workspace });
}
