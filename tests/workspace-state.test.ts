import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { parseWorkspaceState, readWorkspaceState, workspaceStateSchema,
  WORKSPACE_MAX_COUNT, WORKSPACE_TIMEOUT_MS, WORKSPACE_MAX_BYTES } from "../server/workspace-state";

test("workspace statistics contain bounded counters, never filenames or raw output", () => {
  const state = parseWorkspaceState("3\t2\tsecret\tname\nfile\0-\t-\tbinary-key\0", "private-key\0");
  assert.deepEqual(state, { status: "available", basis: "uncommitted", files: 2, added: 3, removed: 2, binary: 1, untracked: 1, capped: false });
  assert.deepEqual(workspaceStateSchema.parse({ ...state, paths: ["private-key"], patch: "secret" }), state);
  const capped = parseWorkspaceState(`${WORKSPACE_MAX_COUNT + 1}\t0\tfile\0`, "");
  assert.ok(capped.status === "available" && capped.capped && capped.added === WORKSPACE_MAX_COUNT);
  assert.throws(() => parseWorkspaceState("unrecognized output", ""));
  assert.throws(() => workspaceStateSchema.parse({ ...state, files: -1 }));
});

test("workspace collection combines staged and unstaged changes and counts untracked files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "auto-routing-workspace-"));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true });
  });
  const exec = promisify(childProcess.execFile);
  const git = (...args: string[]) => exec("git", ["-C", directory, ...args], { windowsHide: true });
  await git("init", "-q");
  await writeFile(join(directory, "baseline.txt"), "one\ntwo\n");
  await git("add", "--", "baseline.txt");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "baseline");
  await writeFile(join(directory, "baseline.txt"), "one\ntwo\nthree\n");
  await git("add", "--", "baseline.txt");
  await writeFile(join(directory, "baseline.txt"), "one\ntwo\nthree\nfour\n");
  await writeFile(join(directory, "private-key.txt"), "not sent");
  assert.deepEqual(await readWorkspaceState(directory), {
    status: "available", basis: "uncommitted", files: 1, added: 2, removed: 0, binary: 0, untracked: 1, capped: false,
  });
  assert.deepEqual(await readWorkspaceState(join(directory, "missing")), { status: "unavailable" });
});

test("failed or oversized Git probes produce unknown state with bounded execution", async (t) => {
  const probe = t.mock.method(childProcess, "execFile", (...args: any[]) => {
    const options = args[2];
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, WORKSPACE_TIMEOUT_MS);
    assert.equal(options.maxBuffer, WORKSPACE_MAX_BYTES);
    args[3](new Error("timeout or output limit; private path"), "private raw output");
  });
  assert.deepEqual(await readWorkspaceState("unused"), { status: "unavailable" });
  assert.equal(probe.mock.callCount(), 2);
});
