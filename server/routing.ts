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
import { selectPreset } from "../shared/presets";
import { matchingPreset, taskTypeOwners } from "./preset-classification";
import { TASK_TYPE_LABELS, type TaskType } from "../shared/task-types";
import { depthRank, TASK_DEPTH_LABELS, type TaskDepth } from "../shared/task-depth";
import type { WorkspaceState } from "./workspace-state";

export type AutoRoute = {
  classifier: "jev" | "laya";
  intent: Intent;
  presetId: string;
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
  const preset = selectPreset(settings, selectedId ?? matchingPreset(settings.presets, answers.presetScores, taskDepth, taskType));
  const notices = selectedId ? [] : [
    ...(taskType !== "other" && !taskTypeOwners(settings.presets, taskType).length
      ? [`No preset is assigned to ${TASK_TYPE_LABELS[taskType]} tasks. Auto used the closest scope.`] : []),
    ...(depthRank(preset.taskDepth) < depthRank(taskDepth)
      ? [`No Auto preset is configured for ${TASK_DEPTH_LABELS[taskDepth]} tasks. Using the deepest available setup (${TASK_DEPTH_LABELS[preset.taskDepth]}).`] : []),
  ];
  return {
    classifier: settings.classifier,
    intent,
    presetId: preset.id,
    provider: preset.provider,
    instructions: preset.instructions,
    model: preset.model,
    effort: preset.effort,
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
  const presets = automatic ? settings.presets : [];
  if (settings.classifier === "laya") {
    return evaluateLayaRoute({ prompt, context, presets, workspace, python: settings.layaPython, cache: settings.layaCache, model: settings.layaModel, device: settings.layaDevice });
  }
  if (settings.classifier !== "jev") throw new Error("Unknown classifier; no provider turn was started.");
  return evaluateRoute({ apiKey: typeSafeKey(settings), model: settings.model.trim() || "jev-latest", prompt, context, presets, workspace });
}
