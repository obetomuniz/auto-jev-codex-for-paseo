import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { z } from "zod";
import { defaults, settingsSchema, toPublic, type ProviderSettings } from "../shared/settings";
import { LEGACY_PERSONA_FIELDS } from "../shared/personas";

const SETTINGS_PATH = join(homedir(), ".paseo", "auto-mode-for-paseo.local.json");

const LEGACY_SETTINGS_PATH = join(homedir(), ".paseo", "auto-jev-codex-for-paseo.local.json");

let pendingSave: Promise<unknown> = Promise.resolve();

const legacyFallbacksSchema = z.object({
  fallbackStaff: z.string().optional(),
  fallbackReview: z.string().optional(),
});

// Old versions resolved blank Auto fields through sidebar fallbacks. Materialize
// those choices before the old fields are stripped on the next settings save.
export function parseStoredSettings(value: unknown): ProviderSettings {
  let settings = settingsSchema.parse(value);
  // Seed the new routing field once. Never infer it from a vendor's reasoning setting.
  const original = z.object({ personas: z.array(z.object({ id: z.string(), taskDepth: z.unknown().optional(), taskTypes: z.unknown().optional() })).optional() }).parse(value);
  settings.personas = settings.personas.map((persona) => {
    const stored = original.personas?.find((item) => item.id === persona.id);
    if (stored && stored.taskDepth === undefined) {
      return { ...persona, taskDepth: defaults.personas.find((preset) => preset.id === persona.id)?.taskDepth ?? "medium" };
    }
    return persona;
  });
  const legacy = legacyFallbacksSchema.parse(value);
  if (legacy.fallbackStaff !== undefined || legacy.fallbackReview !== undefined) {
    const staff = codexModel(legacy.fallbackStaff);
    const review = codexModel(legacy.fallbackReview);
    settings = {
      ...settings,
      autoCodexModelStaff: settings.autoCodexModelStaff.trim() || staff || review || defaults.autoCodexModelStaff,
      autoCodexModelReview: settings.autoCodexModelReview.trim() || review || staff || defaults.autoCodexModelStaff,
      autoCodexModelCheap: settings.autoCodexModelCheap.trim() || review || staff || defaults.autoCodexModelStaff,
      autoCodexModelLead: settings.autoCodexModelLead.trim() || staff || review || defaults.autoCodexModelStaff,
    };
  }
  if (typeof value === "object" && value !== null && !("personas" in value)) {
    settings.personas = settings.personas.map((persona) => {
      const [model, effort] = LEGACY_PERSONA_FIELDS[persona.id as keyof typeof LEGACY_PERSONA_FIELDS];
      return { ...persona, model: settings[model].trim() || defaults[model], effort: settings[effort].trim() || defaults[effort] };
    });
  }
  // Upgrade untouched preset descriptions to editable scopes. User definitions stay intact.
  const previousScopes: Record<string, readonly string[]> = {
    "tech-lead": ["Complex implementation and investigation.", "Delivery, code changes, debugging, and implementation validation."],
    staff: ["Architecture and difficult system decisions.", "Technical strategy, architecture, boundaries, and tradeoffs."],
    critic: ["Reviews, critiques, and independent validation.", "Independent assessment of quality, correctness, risks, and coverage."],
    reporter: ["Direct answers and concise summaries.", "Facts, progress, changes, open questions, and next steps."],
    writer: ["Bounded explanations and routine implementation.", "Prose, documentation, explanations, and user-facing text."],
  };
  // Seed task types once from a matching preset scope. Other scopes are detected in settings.
  settings.personas = settings.personas.map((persona) => {
    const stored = original.personas?.find((item) => item.id === persona.id);
    const preset = defaults.personas.find((item) => item.description === persona.description);
    return stored && stored.taskTypes === undefined && preset
      ? { ...persona, taskTypes: [...preset.taskTypes], taskTypesAuto: true, taskTypesScope: preset.description }
      : persona;
  });
  if (typeof value === "object" && value !== null && !("personaScopeVersion" in value)) {
    settings.personas = settings.personas.map((persona) => Object.hasOwn(previousScopes, persona.id) && previousScopes[persona.id].includes(persona.description)
      ? { ...persona, description: defaults.personas.find((preset) => preset.id === persona.id)!.description }
      : persona);
  }
  return settings;
}

function codexModel(value: string | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.startsWith("codex/") ? normalized.slice("codex/".length).trim() || null : null;
}

export async function loadSettings(): Promise<ProviderSettings> {
  try {
    const raw = await readSettingsFile();
    return parseStoredSettings(JSON.parse(raw));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return defaults;
    } else {
      throw new Error("Could not read Auto Mode for Paseo settings. Fix the settings file before routing a message.");
    }
  }
}

export function saveSettings(values: ProviderSettings) {
  // Serialize across settings screens as well as within one client's autosave.
  const result = pendingSave.then(() => writeSettings(values));
  pendingSave = result.catch(() => {});
  return result;
}

async function writeSettings(values: ProviderSettings) {
  const current = await loadSettings();
  const next = settingsSchema.parse({
    ...values,
    apiKey: values.apiKey.trim() ? values.apiKey : current.apiKey,
  });
  await mkdir(join(homedir(), ".paseo"), { recursive: true });
  const temporary = `${SETTINGS_PATH}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    // Readers see either complete version, including while autosave is running.
    await rename(temporary, SETTINGS_PATH);
  } finally {
    await rm(temporary, { force: true });
  }
  return toPublic(next);
}

async function readSettingsFile(): Promise<string> {
  try { return await readFile(SETTINGS_PATH, "utf8"); }
  catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  // Read the old file only when the new file does not exist. The next save
  // writes the new filename. Keep the original as a migration backup.
  return readFile(LEGACY_SETTINGS_PATH, "utf8");
}
