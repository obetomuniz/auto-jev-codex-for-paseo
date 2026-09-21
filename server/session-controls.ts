import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { ProviderSetting } from "@getpaseo/plugin/server/provider";

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
    { type: "select", id: "fast", label: "Fast mode", description: "Auto starts off; Jev may enable it for urgency. Faster processing may use more quota.", value: controls.fast, options: [
      { label: "Auto (Jev decides)", value: "auto" }, { label: "On", value: "on" }, { label: "Off", value: "off" },
    ] },
    { type: "select", id: "permissions", label: "Permissions", value: controls.permissions, options: [
      { label: "Auto-review (default)", value: "auto-review" },
      { label: "Full access", value: "full-access" },
    ] },
    { type: "select", id: "modelScope", label: "Manual model selection", value: controls.modelScope, options: [
      { label: "Next turn only", value: "next-turn" },
      { label: "Keep selected model", value: "pinned" },
    ] },
  ];
}

export function collaborationModes() {
  return [
    { id: "auto", label: "Auto", description: "Plan starts off; Jev may enable it when planning is needed." },
    { id: "default", label: "Work", description: "Discuss, review, or implement according to your request." },
    { id: "plan", label: "Plan", description: "Explore and plan without modifying the workspace." },
  ];
}
