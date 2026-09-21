import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { defaults, settingsSchema, toPublic, type ProviderSettings } from "../shared/settings";

const SETTINGS_PATH = join(homedir(), ".paseo", "auto-jev-codex.local.json");
const LEGACY_SETTINGS_PATH = join(homedir(), ".paseo", "jev-route.local.json");

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
    const raw = await readCurrentOrLegacySettings();
    cached = parseStoredSettings(JSON.parse(raw));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      cached = defaults;
    } else {
      console.error("Failed to read Auto Jev-Codex settings; using defaults.");
      cached = defaults;
    }
  }
  return cached;
}

async function readCurrentOrLegacySettings(): Promise<string> {
  try {
    return await readFile(SETTINGS_PATH, "utf8");
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return readFile(LEGACY_SETTINGS_PATH, "utf8");
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
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
