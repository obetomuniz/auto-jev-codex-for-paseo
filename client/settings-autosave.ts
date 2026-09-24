import { settingsSchema, type ProviderSettings, type PublicSettings } from "../shared/settings";

// Keep an incomplete persona local until its provider and model form a valid pair.
// Other fields and personas can still save. API keys never enter an automatic save.
export function settingsForAutosave(draft: PublicSettings, previous: ProviderSettings): ProviderSettings {
  const candidate = { ...draft, apiKey: "" };
  const result = settingsSchema.safeParse(candidate);
  if (result.success) return result.data;
  const invalidPersonas = new Set<number>();
  for (const issue of result.error.issues) {
    const field = issue.path[0] as keyof ProviderSettings;
    if (field === "personas" && typeof issue.path[1] === "number") invalidPersonas.add(issue.path[1]);
    else if (field in previous) Object.assign(candidate, { [field]: previous[field] });
  }
  candidate.personas = candidate.personas.flatMap((persona, index) => {
    if (!invalidPersonas.has(index)) return [persona];
    const saved = previous.personas.find((item) => item.id === persona.id);
    return saved ? [saved] : [];
  });
  return settingsSchema.parse(candidate);
}

export type SaveState = { saving: boolean; pending: boolean; error: boolean };

/** Coalesce typing and serialize all writes, including explicitly submitted keys. */
export class SettingsAutosave {
  private desired: ProviderSettings;
  private saved: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private key: { value: string; resolve(): void; reject(error: Error): void } | undefined;
  private listener: ((state: SaveState) => void) | undefined;
  private failed = false;

  constructor(initial: PublicSettings,
    private readonly write: (values: ProviderSettings) => Promise<PublicSettings>,
    private readonly onSaved: (values: PublicSettings) => void,
  ) {
    this.desired = settingsSchema.parse({ ...initial, apiKey: "" });
    this.saved = JSON.stringify(this.desired);
  }

  subscribe(listener: (state: SaveState) => void): () => void {
    this.listener = listener;
    this.notify();
    return () => { this.listener = undefined; };
  }

  update(draft: PublicSettings): void {
    this.desired = settingsForAutosave(draft, this.desired);
    clearTimeout(this.timer);
    this.failed = false;
    if (JSON.stringify(this.desired) !== this.saved) this.timer = setTimeout(() => { void this.flush(); }, 400);
    this.notify();
  }

  saveKey(value: string): Promise<void> {
    if (!value.trim()) return Promise.reject(new Error("Enter an API key."));
    if (this.key) return Promise.reject(new Error("Wait for the current key to save."));
    const result = new Promise<void>((resolve, reject) => { this.key = { value, resolve, reject }; });
    void this.flush();
    return result;
  }

  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.running) return this.running;
    this.failed = false;
    this.running = this.drain().finally(() => {
      this.running = undefined;
      this.notify();
      if (!this.failed && (this.key || JSON.stringify(this.desired) !== this.saved)) void this.flush();
    });
    this.notify();
    return this.running;
  }

  private async drain(): Promise<void> {
    while (this.key || JSON.stringify(this.desired) !== this.saved) {
      const snapshot = this.desired;
      const key = this.key;
      this.key = undefined;
      try {
        const values = await this.write({ ...snapshot, apiKey: key?.value ?? "" });
        this.saved = JSON.stringify(snapshot);
        this.onSaved(values);
        key?.resolve();
      } catch {
        this.failed = true;
        key?.reject(new Error("Could not save the API key. Try again."));
        // A key queued behind a failed automatic save must not remain pending.
        this.rejectQueuedKey();
        return;
      }
    }
  }

  private notify(): void {
    const pending = JSON.stringify(this.desired) !== this.saved;
    this.listener?.({ saving: Boolean(this.running), pending, error: this.failed && pending });
  }

  private rejectQueuedKey(): void {
    this.key?.reject(new Error("Could not save the API key. Try again."));
    this.key = undefined;
  }
}
