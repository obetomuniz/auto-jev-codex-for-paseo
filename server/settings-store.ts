import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { z } from "zod";
import { defaults, settingsSchema, toPublic, type ProviderSettings } from "../shared/settings";
import { LEGACY_PRESET_FIELDS } from "../shared/presets";

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
  const original = z.object({ presets: z.array(z.object({ id: z.string(), taskDepth: z.unknown().optional(), taskTypes: z.unknown().optional() })).optional() }).parse(value);
  settings.presets = settings.presets.map((preset) => {
    const stored = original.presets?.find((item) => item.id === preset.id);
    if (stored && stored.taskDepth === undefined) {
      return { ...preset, taskDepth: defaults.presets.find((item) => item.id === preset.id)?.taskDepth ?? "medium" };
    }
    return preset;
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
  if (typeof value === "object" && value !== null && !("presets" in value)) {
    settings.presets = settings.presets.map((preset) => {
      const [model, effort] = LEGACY_PRESET_FIELDS[preset.id as keyof typeof LEGACY_PRESET_FIELDS];
      return { ...preset, model: settings[model].trim() || defaults[model], effort: settings[effort].trim() || defaults[effort] };
    });
  }
  // Upgrade untouched default descriptions to editable scopes. User definitions stay intact.
  const previousScopes: Record<string, readonly string[]> = {
    "tech-lead": ["Complex implementation and investigation.", "Delivery, code changes, debugging, and implementation validation."],
    staff: ["Architecture and difficult system decisions.", "Technical strategy, architecture, boundaries, and tradeoffs."],
    critic: ["Reviews, critiques, and independent validation.", "Independent assessment of quality, correctness, risks, and coverage."],
    reporter: ["Direct answers and concise summaries.", "Facts, progress, changes, open questions, and next steps."],
    writer: ["Bounded explanations and routine implementation.", "Prose, documentation, explanations, and user-facing text."],
  };
  // Seed task types once from a matching default scope. Other scopes are detected in settings.
  settings.presets = settings.presets.map((preset) => {
    const stored = original.presets?.find((item) => item.id === preset.id);
    const builtIn = defaults.presets.find((item) => item.description === preset.description);
    return stored && stored.taskTypes === undefined && builtIn
      ? { ...preset, taskTypes: [...builtIn.taskTypes], taskTypesAuto: true, taskTypesScope: builtIn.description }
      : preset;
  });
  if (typeof value === "object" && value !== null && !("presetScopeVersion" in value)) {
    settings.presets = settings.presets.map((preset) => Object.hasOwn(previousScopes, preset.id) && previousScopes[preset.id].includes(preset.description)
      ? { ...preset, description: defaults.presets.find((item) => item.id === preset.id)!.description }
      : preset);
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
