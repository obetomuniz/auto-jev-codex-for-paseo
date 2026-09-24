import { execFile } from "node:child_process";
import { z } from "zod";

export const WORKSPACE_TIMEOUT_MS = 1_500;
export const WORKSPACE_MAX_BYTES = 256 * 1024;
export const WORKSPACE_MAX_COUNT = 1_000_000;
const count = z.number().int().min(0).max(WORKSPACE_MAX_COUNT);
export const workspaceStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unavailable") }),
  z.object({ status: z.literal("available"), basis: z.literal("uncommitted"),
    files: count, added: count, removed: count, binary: count, untracked: count, capped: z.boolean() }),
]);
export type WorkspaceState = z.output<typeof workspaceStateSchema>;

// Only counters cross the classifier boundary. Never send paths, patches or command output.
export function parseWorkspaceState(numstat: string, untracked: string): WorkspaceState {
  let files = 0, added = 0, removed = 0, binary = 0;
  for (const record of numstat.split("\0")) {
    if (!record) continue;
    const match = /^(\d+|-)\t(\d+|-)\t[\s\S]+$/.exec(record);
    if (!match) throw new Error("Invalid change statistics.");
    files++;
    if (match[1] === "-" || match[2] === "-") binary++;
    else { added += Number(match[1]); removed += Number(match[2]); }
  }
  const values = { files, added, removed, binary, untracked: untracked.split("\0").filter(Boolean).length };
  const capped = Object.values(values).some((value) => value > WORKSPACE_MAX_COUNT);
  return workspaceStateSchema.parse({ status: "available", basis: "uncommitted", capped,
    ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Math.min(value, WORKSPACE_MAX_COUNT)])) });
}

export async function readWorkspaceState(cwd: string): Promise<WorkspaceState> {
  const git = (args: string[]) => new Promise<string>((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], {
      shell: false, windowsHide: true, timeout: WORKSPACE_TIMEOUT_MS, maxBuffer: WORKSPACE_MAX_BYTES, encoding: "utf8",
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
  try {
    const [diff, untracked] = await Promise.all([
      git(["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "HEAD", "--"]),
      git(["ls-files", "--others", "--exclude-standard", "-z"]),
    ]);
    return parseWorkspaceState(diff, untracked);
  } catch {
    // No repository, timeout or output limit means unknown size, never an easy task.
    return { status: "unavailable" };
  }
}
