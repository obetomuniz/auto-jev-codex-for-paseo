import { defaults, settingsSchema, type Persona } from "../shared/settings";
import { depthRank, type TaskDepth } from "../shared/task-depth";
import { assignedTaskTypes } from "../shared/personas";
import type { TaskType } from "../shared/task-types";

// Fit questions share the existing inference call. Each has its own Laya token budget.
export function personaQuestions(personas: readonly Persona[] = defaults.personas) {
  const candidates = settingsSchema.shape.personas.parse(personas)
    .filter((persona) => persona.enabled && persona.description.trim().length > 0)
    .sort((a, b) => a.id.localeCompare(b.id));
  const questions = Object.fromEntries(candidates.map((persona, index) => {
    return [`persona_${index}`, {
      type: "noul" as const,
      instructions: "Does the latest request ask for work in this scope? Judge the latest request itself. Use recentConversation only to resolve references such as \"it\"; earlier topics do not carry over. A quality judgment is different from a factual status report. Scope: " + persona.description,
    }];
  }));
  return { ids: candidates.map((persona) => persona.id), questions };
}

/** Enabled scoped personas explicitly assigned to a task type. Untagged personas do not count. */
export function taskTypeOwners(personas: readonly Persona[], taskType: TaskType): Persona[] {
  return personas.filter((persona) => persona.enabled && persona.description.trim() && assignedTaskTypes(persona)?.includes(taskType));
}

export function matchingPersona(personas: readonly Persona[], scores: Record<string, number> = {}, requiredDepth: TaskDepth = "low", taskType?: TaskType): string | undefined {
  const scored = personas.filter((persona) => persona.enabled && persona.description.trim()
    && Number.isFinite(scores[persona.id]) && scores[persona.id] >= 0 && scores[persona.id] <= 1);
  // The fixed task type bounds a weak scope score: owners and untagged personas compete.
  // Without an owner, every scored persona competes and routing reports that fallback.
  const owners = taskType ? scored.filter((persona) => assignedTaskTypes(persona)?.includes(taskType)) : [];
  const candidates = owners.length ? scored.filter((persona) => owners.includes(persona) || assignedTaskTypes(persona) === null) : scored;
  const sufficient = candidates.filter((persona) => depthRank(persona.taskDepth) >= depthRank(requiredDepth));
  // With no sufficient setup, use the deepest available option and disclose that limit.
  const deepest = Math.max(...candidates.map((persona) => depthRank(persona.taskDepth)));
  const pool = sufficient.length ? sufficient : candidates.filter((persona) => depthRank(persona.taskDepth) === deepest);
  return pool.sort((a, b) => scores[b.id] - scores[a.id]
    || depthRank(a.taskDepth) - depthRank(b.taskDepth) || a.id.localeCompare(b.id))[0]?.id;
}
