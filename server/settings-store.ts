import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { defaults, settingsSchema, toPublic, type ProviderSettings } from "../shared/settings";

const SETTINGS_PATH = join(homedir(), ".paseo", "auto-mode-for-paseo.local.json");

const LEGACY_SETTINGS_PATH = join(homedir(), ".paseo", "auto-jev-codex-for-paseo.local.json");

let cached: ProviderSettings = defaults;

const legacyFallbacksSchema = z.object({
  fallbackStaff: z.string().optional(),
  fallbackReview: z.string().optional(),
});

// Old versions resolved blank Auto fields through sidebar fallbacks. Materialize
// those choices before the old fields are stripped on the next settings save.
export function parseStoredSettings(value: unknown): ProviderSettings {
  const settings = settingsSchema.parse(value);
  const legacy = legacyFallbacksSchema.parse(value);
  if (legacy.fallbackStaff === undefined && legacy.fallbackReview === undefined) return settings;

  const staff = codexModel(legacy.fallbackStaff);
  const review = codexModel(legacy.fallbackReview);
  return {
    ...settings,
    autoCodexModelStaff: settings.autoCodexModelStaff.trim() || staff || review || defaults.autoCodexModelStaff,
    autoCodexModelReview: settings.autoCodexModelReview.trim() || review || staff || defaults.autoCodexModelStaff,
    autoCodexModelCheap: settings.autoCodexModelCheap.trim() || review || staff || defaults.autoCodexModelStaff,
    autoCodexModelLead: settings.autoCodexModelLead.trim() || staff || review || defaults.autoCodexModelStaff,
  };
}

function codexModel(value: string | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.startsWith("codex/") ? normalized.slice("codex/".length).trim() || null : null;
}

export async function loadSettings(): Promise<ProviderSettings> {
  try {
    const raw = await readSettingsFile();
    cached = parseStoredSettings(JSON.parse(raw));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      cached = defaults;
    } else {
      throw new Error("Could not read Auto Mode for Paseo settings. Fix the settings file before routing a message.");
    }
  }
  return cached;
}

export async function saveSettings(values: ProviderSettings) {
  const current = await loadSettings();
  cached = settingsSchema.parse({
    ...values,
    apiKey: values.apiKey.trim() ? values.apiKey : current.apiKey,
  });
  await mkdir(join(homedir(), ".paseo"), { recursive: true });
  await writeFile(SETTINGS_PATH, `${JSON.stringify(cached, null, 2)}\n`, "utf8");
  return toPublic(cached);
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
