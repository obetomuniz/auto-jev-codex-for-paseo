import { defaults, MAX_PRESETS, type Preset, type ProviderSettings } from "./settings";
import type { TaskType } from "./task-types";

export const LEGACY_PRESET_FIELDS = {
  staff: ["autoCodexModelStaff", "autoCodexEffortStaff"],
  critic: ["autoCodexModelReview", "autoCodexEffortReview"],
  reporter: ["autoCodexModelCheap", "autoCodexEffortCheap"],
  writer: ["autoCodexModelStandard", "autoCodexEffortStandard"],
  "tech-lead": ["autoCodexModelLead", "autoCodexEffortLead"],
} as const;

export function missingDefaultPresets(presets: readonly Preset[]): Preset[] {
  const ids = new Set(presets.map((preset) => preset.id));
  return defaults.presets.filter((preset) => !ids.has(preset.id)).map((preset) => ({ ...preset }));
}

export function restoreDefaultPresets(presets: readonly Preset[]): Preset[] {
  const missing = missingDefaultPresets(presets);
  if (presets.length + missing.length > MAX_PRESETS) {
    throw new Error(`Remove presets to make room before restoring defaults. The limit is ${MAX_PRESETS}.`);
  }
  return [...presets, ...missing];
}

export function selectPreset(settings: ProviderSettings, id: string | undefined): Preset {
  if (!id) throw new Error("Auto needs an enabled preset with a Scope. Add or enable one in plugin settings, or select a preset manually.");
  const preset = settings.presets.find((item) => item.id === id && item.enabled);
  if (!preset) throw new Error(`Preset '${id}' is disabled or missing. Enable or restore it in the plugin settings, or select another preset.`);
  return preset;
}

/** Manual tags always apply. Detected tags apply only to the scope they came from; null means untagged. */
export function assignedTaskTypes(preset: Pick<Preset, "description" | "taskTypes" | "taskTypesAuto" | "taskTypesScope">): readonly TaskType[] | null {
  if (!preset.taskTypesAuto) return preset.taskTypes.length ? preset.taskTypes : null;
  return preset.taskTypes.length && preset.taskTypesScope.trim() === preset.description.trim() ? preset.taskTypes : null;
}
