import { defaults, settingsSchema, type Preset } from "../shared/settings";
import { depthRank, type TaskDepth } from "../shared/task-depth";
import { assignedTaskTypes } from "../shared/presets";
import type { TaskType } from "../shared/task-types";

// Fit questions share the existing inference call. Each has its own Laya token budget.
export function presetQuestions(presets: readonly Preset[] = defaults.presets) {
  const candidates = settingsSchema.shape.presets.parse(presets)
    .filter((preset) => preset.enabled && preset.description.trim().length > 0)
    .sort((a, b) => a.id.localeCompare(b.id));
  const questions = Object.fromEntries(candidates.map((preset, index) => {
    return [`preset_${index}`, {
      type: "noul" as const,
      instructions: "Does the latest request ask for work in this scope? Judge the latest request itself. Use recentConversation only to resolve references such as \"it\"; earlier topics do not carry over. A quality judgment is different from a factual status report. Scope: " + preset.description,
    }];
  }));
  return { ids: candidates.map((preset) => preset.id), questions };
}

/** Enabled scoped presets explicitly assigned to a task type. Untagged presets do not count. */
export function taskTypeOwners(presets: readonly Preset[], taskType: TaskType): Preset[] {
  return presets.filter((preset) => preset.enabled && preset.description.trim() && assignedTaskTypes(preset)?.includes(taskType));
}

export function matchingPreset(presets: readonly Preset[], scores: Record<string, number> = {}, requiredDepth: TaskDepth = "low", taskType?: TaskType): string | undefined {
  const scored = presets.filter((preset) => preset.enabled && preset.description.trim()
    && Number.isFinite(scores[preset.id]) && scores[preset.id] >= 0 && scores[preset.id] <= 1);
  // The fixed task type bounds a weak scope score: owners and untagged presets compete.
  // Without an owner, every scored preset competes and routing reports that fallback.
  const owners = taskType ? scored.filter((preset) => assignedTaskTypes(preset)?.includes(taskType)) : [];
  const candidates = owners.length ? scored.filter((preset) => owners.includes(preset) || assignedTaskTypes(preset) === null) : scored;
  const sufficient = candidates.filter((preset) => depthRank(preset.taskDepth) >= depthRank(requiredDepth));
  // With no sufficient setup, use the deepest available option and disclose that limit.
  const deepest = Math.max(...candidates.map((preset) => depthRank(preset.taskDepth)));
  const pool = sufficient.length ? sufficient : candidates.filter((preset) => depthRank(preset.taskDepth) === deepest);
  return pool.sort((a, b) => scores[b.id] - scores[a.id]
    || depthRank(a.taskDepth) - depthRank(b.taskDepth) || a.id.localeCompare(b.id))[0]?.id;
}
