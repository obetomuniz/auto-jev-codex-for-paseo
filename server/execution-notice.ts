import type { Preset } from "../shared/settings";
import type { Intent } from "./classifier";
import { TASK_DEPTH_LABELS, type TaskDepth } from "../shared/task-depth";
import { TASK_TYPE_LABELS, type TaskType } from "../shared/task-types";

/** One user-facing summary of the configuration applied to a started turn. */
export function executionNotice(input: {
  preset: Preset;
  intent: Intent;
  manual?: boolean;
  modelLabel?: string;
  modeLabel: string;
  effort?: string;
  taskDepth?: TaskDepth;
  taskType?: TaskType;
  fast: boolean;
  notices?: string[];
}): string {
  const intent = { discuss: "Discussion", review: "Review", implement: "Implementation" }[input.intent];
  const summary = [
    `${input.manual ? "Selected" : "Auto"}: ${input.preset.name}`,
    `${input.preset.provider}/${input.modelLabel || input.preset.model}`,
    intent,
    ...(input.taskType ? [`Type: ${TASK_TYPE_LABELS[input.taskType]}`] : []),
    ...(input.taskDepth ? [`Depth: ${TASK_DEPTH_LABELS[input.taskDepth]}`] : []),
    `Mode: ${input.modeLabel}`,
    `Reasoning: ${input.effort || "provider default"}`,
    ...(input.fast ? ["Fast on"] : []),
  ].join(" · ");
  return `${summary}. ${(input.notices ?? []).join(" ")}`.trim();
}
