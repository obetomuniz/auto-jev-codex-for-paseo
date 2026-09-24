export type NativeMode = { id: string; label: string };

const planIds = ["plan", "read-only", "readonly", "https://agentclientprotocol.com/protocol/session-modes#plan"];
const fullIds = ["bypassPermissions", "full-access", "danger-full-access", "full", "yolo", "unrestricted"];

export function planningMode(modes: readonly NativeMode[]) {
  return planIds.map((id) => modes.find((mode) => mode.id === id)).find(Boolean);
}

export function fullAccessMode(modes: readonly NativeMode[]) {
  return fullIds.map((id) => modes.find((mode) => mode.id === id)).find(Boolean);
}

export function workModes(modes: readonly NativeMode[]): NativeMode[] {
  return modes.filter((mode) => !planIds.includes(mode.id) && !fullIds.includes(mode.id));
}

export function automaticWorkMode(modes: readonly NativeMode[]) {
  const available = workModes(modes);
  return ["auto", "auto-review", "default", "ask", "acceptEdits", "agent", "build", "https://agentclientprotocol.com/protocol/session-modes#agent"]
    .map((id) => available.find((mode) => mode.id === id)).find(Boolean);
}
