import type { ProviderMode, ProviderSessionConfig, ProviderSetting } from "@getpaseo/plugin/server/provider";

type JsonValue = ProviderSessionConfig["settings"][string];

export type Controls = {
  fast: "auto" | "on" | "off";
  permissions: "auto-review" | "full-access";
  modelScope: "next-turn" | "pinned";
};
export const defaultControls: Controls = { fast: "auto", permissions: "auto-review", modelScope: "next-turn" };

export function parseControls(input: Readonly<Record<string, JsonValue>>, current = defaultControls): Controls {
  const result = { ...current };
  for (const [key, value] of Object.entries(input)) {
    if (key === "fast" && (value === "auto" || value === "on" || value === "off")) result.fast = value;
    else if (key === "permissions" && (value === "auto-review" || value === "full-access")) result.permissions = value;
    else if (key === "modelScope" && (value === "next-turn" || value === "pinned")) result.modelScope = value;
    else throw new Error("Unknown or invalid session setting: " + key);
  }
  return result;
}

export function controlSettings(controls: Controls): ProviderSetting[] {
  return [
    { type: "select", id: "fast", label: "Fast mode", description: "Auto starts off. The classifier may request it for urgency. Uses the model's Fast option when available; otherwise uses normal speed. Faster processing may use more quota.", value: controls.fast, options: [
      { label: "Auto (classifier decides)", value: "auto" }, { label: "On", value: "on" }, { label: "Off", value: "off" },
    ] },
    { type: "select", id: "permissions", label: "Permissions", description: "Uses the preset's native work mode unless Plan is enabled. Full access requests bypass only when you select it.", value: controls.permissions, options: [
      { label: "Automatic approvals (default)", value: "auto-review" },
      { label: "Full access", value: "full-access" },
    ] },
    { type: "select", id: "modelScope", label: "Preset selection", value: controls.modelScope, options: [
      { label: "Next turn only", value: "next-turn" },
      { label: "Keep selected preset", value: "pinned" },
    ] },
  ];
}

export function collaborationModes(): ProviderMode[] {
  return [
    { id: "auto", label: "Auto (plan or work)", icon: "Bot", description: "Let the classifier choose whether to plan or work on this turn. Uses your selected permissions." },
    { id: "default", label: "Work on request", icon: "Shield", description: "Answer, review, or implement your request without automatically enabling Plan. Uses your selected permissions." },
    { id: "plan", label: "Plan only", icon: "ShieldEllipsis", description: "Ask the provider to plan without editing. Uses its native planning mode when available." },
  ];
}
