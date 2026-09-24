import { defaults, MAX_PERSONAS, type Persona, type ProviderSettings } from "./settings";
import type { TaskType } from "./task-types";

export const LEGACY_PERSONA_FIELDS = {
  staff: ["autoCodexModelStaff", "autoCodexEffortStaff"],
  critic: ["autoCodexModelReview", "autoCodexEffortReview"],
  reporter: ["autoCodexModelCheap", "autoCodexEffortCheap"],
  writer: ["autoCodexModelStandard", "autoCodexEffortStandard"],
  "tech-lead": ["autoCodexModelLead", "autoCodexEffortLead"],
} as const;

export function missingDefaultPersonas(personas: readonly Persona[]): Persona[] {
  const ids = new Set(personas.map((persona) => persona.id));
  return defaults.personas.filter((persona) => !ids.has(persona.id)).map((persona) => ({ ...persona }));
}

export function restoreDefaultPersonas(personas: readonly Persona[]): Persona[] {
  const missing = missingDefaultPersonas(personas);
  if (personas.length + missing.length > MAX_PERSONAS) {
    throw new Error(`Remove personas to make room before restoring defaults. The limit is ${MAX_PERSONAS}.`);
  }
  return [...personas, ...missing];
}

export function selectPersona(settings: ProviderSettings, id: string | undefined): Persona {
  if (!id) throw new Error("Auto needs an enabled persona with a Scope. Add or enable one in plugin settings, or select a persona manually.");
  const persona = settings.personas.find((item) => item.id === id && item.enabled);
  if (!persona) throw new Error(`Persona '${id}' is disabled or missing. Enable or restore it in the plugin settings, or select another persona.`);
  return persona;
}

/** Manual tags always apply. Detected tags apply only to the scope they came from; null means untagged. */
export function assignedTaskTypes(persona: Pick<Persona, "description" | "taskTypes" | "taskTypesAuto" | "taskTypesScope">): readonly TaskType[] | null {
  if (!persona.taskTypesAuto) return persona.taskTypes.length ? persona.taskTypes : null;
  return persona.taskTypes.length && persona.taskTypesScope.trim() === persona.description.trim() ? persona.taskTypes : null;
}
