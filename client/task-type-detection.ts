import type { Preset } from "../shared/settings";
import type { TaskType } from "../shared/task-types";

export const DETECT_DELAY_MS = 800;
export type DetectionState = { detecting: boolean; error?: string };

/** Detected tags are stale when the scope changed since detection. */
export function needsDetection(preset: Pick<Preset, "description" | "taskTypesAuto" | "taskTypesScope">): boolean {
  const scope = preset.description.trim();
  return preset.taskTypesAuto && scope.length > 0 && preset.taskTypesScope.trim() !== scope;
}

/**
 * Detect task types after a scope stops changing. Each scope text is sent at most
 * once until retry. Results arrive only while that scope is still current.
 */
export class TaskTypeDetector {
  private readonly current = new Map<string, string>();
  private readonly timers = new Map<string, { scope: string; timer: ReturnType<typeof setTimeout> }>();
  private readonly attempted = new Map<string, string>();
  private readonly inFlight = new Map<string, string>();
  private readonly errors = new Map<string, { scope: string; message: string }>();
  private disposed = false;

  constructor(
    private readonly detect: (description: string) => Promise<TaskType[]>,
    private readonly onDetected: (id: string, description: string, taskTypes: TaskType[]) => void,
    private readonly onState: (states: Record<string, DetectionState>) => void,
    private readonly delay = DETECT_DELAY_MS,
  ) {}

  update(presets: readonly Preset[]): void {
    if (this.disposed) return;
    const ids = new Set(presets.map((preset) => preset.id));
    for (const id of new Set([...this.current.keys(), ...this.timers.keys(), ...this.attempted.keys()])) {
      if (!ids.has(id)) { this.clearTimer(id); this.current.delete(id); this.attempted.delete(id); this.errors.delete(id); }
    }
    for (const preset of presets) {
      const scope = preset.description.trim();
      if (!needsDetection(preset)) { this.current.delete(preset.id); this.clearTimer(preset.id); continue; }
      this.current.set(preset.id, scope);
      if (this.timers.get(preset.id)?.scope !== scope) this.clearTimer(preset.id);
      if (this.attempted.get(preset.id) === scope || this.timers.has(preset.id)) continue;
      this.timers.set(preset.id, { scope, timer: setTimeout(() => { void this.run(preset.id, scope); }, this.delay) });
    }
    this.emit();
  }

  /** Allow the current scope text to be detected again, for example after an error. */
  retry(id: string): void {
    this.attempted.delete(id);
    this.errors.delete(id);
  }

  dispose(): void {
    this.disposed = true;
    for (const id of [...this.timers.keys()]) this.clearTimer(id);
  }

  private async run(id: string, scope: string): Promise<void> {
    this.timers.delete(id);
    this.attempted.set(id, scope);
    this.inFlight.set(id, scope);
    this.errors.delete(id);
    this.emit();
    try {
      const taskTypes = await this.detect(scope);
      if (!this.disposed && this.current.get(id) === scope) this.onDetected(id, scope, taskTypes);
    } catch (error) {
      this.errors.set(id, { scope, message: error instanceof Error ? error.message : "Could not detect task types." });
    } finally {
      if (this.inFlight.get(id) === scope) this.inFlight.delete(id);
      this.emit();
    }
  }

  private clearTimer(id: string): void {
    const pending = this.timers.get(id);
    if (pending) clearTimeout(pending.timer);
    this.timers.delete(id);
  }

  private emit(): void {
    if (this.disposed) return;
    const states: Record<string, DetectionState> = {};
    for (const [id, scope] of this.current) {
      const error = this.errors.get(id);
      states[id] = {
        detecting: this.timers.get(id)?.scope === scope || this.inFlight.get(id) === scope,
        ...(error?.scope === scope ? { error: error.message } : {}),
      };
    }
    this.onState(states);
  }
}
