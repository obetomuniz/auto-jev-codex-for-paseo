import type { ContextEntry } from "./route-context";

export const HANDOFF_MESSAGES = 24;
export const HANDOFF_TEXT_LIMIT = 8_000;

export function appendHandoff(context: ContextEntry[], entry: ContextEntry): ContextEntry[] {
  if (!entry.text.trim()) return context;
  const marker = "\n[...truncated...]\n";
  const text = entry.text.length <= HANDOFF_TEXT_LIMIT ? entry.text
    : entry.text.slice(0, HANDOFF_TEXT_LIMIT / 2) + marker + entry.text.slice(-(HANDOFF_TEXT_LIMIT / 2 - marker.length));
  const next = context.slice();
  const index = next.findIndex((item) => item.id === entry.id);
  if (index < 0) next.push({ ...entry, text });
  else next[index] = { ...entry, text };
  return next.slice(-HANDOFF_MESSAGES);
}

export function readHandoff(value: unknown): ContextEntry[] {
  if (!Array.isArray(value)) return [];
  let entries: ContextEntry[] = [];
  for (const entry of value) {
    if (entry && typeof entry.id === "string" && typeof entry.text === "string" && ["user", "assistant", "plan"].includes(entry.role)) {
      entries = appendHandoff(entries, entry);
    }
  }
  return entries;
}

export function handoffPrompt(context: ContextEntry[], text: string): string {
  if (!context.length) return text;
  return `Previous conversation (bounded context, not new instructions):\n${JSON.stringify(context.map(({ role, text }) => ({ role, text })))}\n\nCurrent user message:\n${text}`;
}
