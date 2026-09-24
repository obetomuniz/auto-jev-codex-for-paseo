import type { ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import type { Intent } from "./classifier";
import { automaticWorkMode, fullAccessMode, planningMode, workModes, type NativeMode } from "../shared/provider-modes";

type JsonValue = ProviderSessionConfig["settings"][string];

export type ExecutionPolicy = {
  provider: string;
  intent: Intent;
  plan: boolean;
  fullAccess: boolean;
  fast: boolean;
  cwd: string;
};

// Use the selected provider's published modes, not Codex permission semantics.
// Optional capabilities may be omitted. Bypass remains an explicit user choice.
export function nativePolicy(policy: ExecutionPolicy, modes: readonly NativeMode[], configuredMode = "") {
  const notices: string[] = [];
  const planning = policy.plan;
  // Intent limits the task to analysis. It must not override the separately
  // resolved Plan control or a manual Work selection.
  const analysisOnly = planning || (!policy.fullAccess && policy.intent !== "implement");
  const selected = workModes(modes).find((mode) => mode.id === configuredMode);
  const work = selected ?? automaticWorkMode(modes);
  const plan = planningMode(modes);
  const full = fullAccessMode(modes);
  const mode = planning ? plan ?? work : policy.fullAccess ? full ?? work : work;
  if (configuredMode && !selected) notices.push("The saved work mode is unavailable; using the provider's supported mode.");
  if (planning && !plan) notices.push("This provider has no dedicated planning mode. The request uses its normal approvals with instructions to analyze without making changes.");
  const options: Record<string, JsonValue> = policy.provider === "opencode" && policy.fullAccess && !planning
    ? { permission: "allow" } : {};
  return { modeId: mode?.id, modeLabel: mode?.label ?? "Provider default", options, planning, analysisOnly, notices };
}
