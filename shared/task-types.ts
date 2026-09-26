import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// A fixed taxonomy keeps classification stable while scopes stay free text.
export const TASK_TYPES = ["review", "implement", "design", "report", "write", "other"] as const;
export type TaskType = (typeof TASK_TYPES)[number];
export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  review: "Review", implement: "Implement", design: "Design", report: "Report", write: "Write", other: "Other",
};
export const TASK_TYPE_CRITERIA: Record<TaskType, string> = {
  review: "Evaluate existing work for quality, correctness, risks, or test coverage",
  implement: "Build, fix, refactor, configure, or test code and files",
  design: "Decide strategy, architecture, boundaries, or tradeoffs before building",
  report: "Report status or progress, summarize changes, or answer factual questions about the work",
  write: "Draft, edit, or translate prose such as docs, articles, release notes, or messages",
  other: "Greetings, tests, chit-chat, or requests outside these types",
};

export const detectTaskTypesRpc = defineRpc({
  name: "presets.detect-task-types",
  input: z.object({ description: z.string().trim().max(240, "Use 240 characters or fewer.") }),
  output: z.object({ taskTypes: z.array(z.enum(TASK_TYPES)).max(TASK_TYPES.length) }),
});
