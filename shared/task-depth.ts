export const TASK_DEPTHS = ["low", "medium", "high", "xhigh"] as const;
export type TaskDepth = (typeof TASK_DEPTHS)[number];
export const TASK_DEPTH_LABELS: Record<TaskDepth, string> = {
  low: "Light", medium: "Standard", high: "Deep", xhigh: "Expert",
};

export function depthRank(depth: TaskDepth): number {
  return TASK_DEPTHS.indexOf(depth);
}
