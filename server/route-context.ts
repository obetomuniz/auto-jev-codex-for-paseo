export type ContextEntry = { id: string; role: "user" | "assistant" | "plan"; text: string };
export const CONTEXT_MESSAGES = 6;
export const CONTEXT_TEXT_LIMIT = 1000;

// Keep conversational text only; tool outputs and private reasoning are excluded.
export function appendContext(context: ContextEntry[], entry: ContextEntry): ContextEntry[] {
  const text = entry.text.trim();
  if (!text) return context;
  const marker = "\n[...truncated...]\n";
  const clipped = text.length > CONTEXT_TEXT_LIMIT
    ? text.slice(0, 500) + marker + text.slice(-(CONTEXT_TEXT_LIMIT - 500 - marker.length))
    : text;
  const existing = context.findIndex((item) => item.id === entry.id);
  const next = context.slice();
  const value = { ...entry, text: clipped };
  if (existing >= 0) next[existing] = value;
  else next.push(value);
  return next.slice(-CONTEXT_MESSAGES);
}

export function readContext(value: unknown): ContextEntry[] {
  if (!Array.isArray(value)) return [];
  let context: ContextEntry[] = [];
  for (const entry of value) {
    if (entry && typeof entry.id === "string" && typeof entry.text === "string"
      && ["user", "assistant", "plan"].includes(entry.role)) {
      context = appendContext(context, entry);
    }
  }
  return context;
}
