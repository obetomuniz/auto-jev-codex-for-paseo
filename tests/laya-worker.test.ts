import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { LAYA_WORKER } from "../server/laya-worker";
import { LAYA_QUESTIONS } from "../server/laya-questions";
import { presetQuestions } from "../server/preset-classification";
import { defaults, MAX_PRESETS } from "../shared/settings";

const python = process.env.LAYA_TEST_PYTHON ?? (existsSync(".test-python/python.exe") ? resolve(".test-python/python.exe") : "python");
const available = spawnSync(python, ["--version"], { windowsHide: true }).status === 0;
const fake = String.raw`
import json, sys, types
class Tokenizer:
    mask_token = "[MASK]"
    def __call__(self, text, **kwargs):
        return {"input_ids": text.split()}
class Agent:
    cfg = {"max_len": 1024, "head_max_len": 256}
    tok = Tokenizer()
    device = types.SimpleNamespace(type="cpu")
    def _to_internal(self, question):
        return {"t": question["type"], "ins": question["instructions"], "crit": question.get("criteria")}
    def predict(self, state, questions):
        print("library output must not enter the protocol")
        if state["request"] == "RAISE":
            raise RuntimeError("private text must not appear in errors")
        return {"answers": {"echo": state["request"]}}
def load(*args, **kwargs):
    print("loading library output")
    return Agent()
common = types.ModuleType("laya.common")
common.serialize_state = lambda state: state if isinstance(state, str) else json.dumps(state, ensure_ascii=False)
common.render_options = lambda q: [k + ": " + v for k, v in q["crit"].items()] if q["t"] == "choice" else ["false: no, the statement does not hold", "true: yes, the statement holds"]
laya = types.ModuleType("laya")
laya.__version__ = "0.3.5"
laya.load = load
sys.modules["laya"] = laya
sys.modules["laya.common"] = common
`;

function run(driver: string, input = "") {
  return spawnSync(python, ["-I", "-c", fake + driver, JSON.stringify({ model: "multilingual", device: "cpu" }), LAYA_WORKER, JSON.stringify(LAYA_QUESTIONS)], {
    input, encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
}
function requiresPython(t: { skip(message: string): void }) {
  if (!available) {
    assert.ok(!process.env.CI, "CI requires Python for the bridge tests");
    t.skip("Install Python or set LAYA_TEST_PYTHON to run bridge tests.");
    return false;
  }
  return true;
}

test("Python bridge keeps stdout as JSON and handles multiple UTF-8 requests", (t) => {
  if (!requiresPython(t)) return;
  const state = { request: "Ol\u00e1, revise o c\u00f3digo", recentConversation: [] };
  const messages = [state, { request: "RAISE" }, { request: "x ".repeat(1100) }];
  const result = run('\nexec(sys.argv[2], {"__name__": "__main__"})\n', messages.map((state) => JSON.stringify({ state, questions: LAYA_QUESTIONS }) + "\n").join(""));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n").map((line) => JSON.parse(line)), [
    { ready: true }, { answers: { echo: state.request } }, { error: "inference" }, { error: "context" },
  ]);
  assert.ok(!result.stdout.includes("private text"));
  assert.ok(!result.stdout.includes("library output"));
});

test("Python bridge checks exact state and question token boundaries", (t) => {
  if (!requiresPython(t)) return;
  const result = run(String.raw`
namespace = {"__name__": "bridge_test"}
exec(sys.argv[2], namespace)
check = namespace["check_budget"]
agent = Agent()
questions = json.loads(sys.argv[3])
check(agent, {"request": "review the code"}, questions)
agent.cfg = {"max_len": 128, "head_max_len": 32}
question = {"q": {"type": "choice", "instructions": "classify", "criteria": {"yes": "approve", "no": "reject"}}}
# 3 instruction tokens, 6 option tokens including markers, 4 special tokens.
check(agent, "word " * 115, question)
def rejected(state, q):
    try:
        check(agent, state, q)
    except ValueError:
        return
    raise AssertionError("input should exceed the budget")
rejected("word " * 116, question)
rejected("short", {"q": {"type": "choice", "instructions": "word " * 50, "criteria": {"yes": "approve"}}})
rejected("short", {"q": {"type": "choice", "instructions": "classify", "criteria": {"yes": "word " * 50}}})
print("ok")
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "ok");
});

test("Python bridge rejects oversized lines and incompatible versions", (t) => {
  if (!requiresPython(t)) return;
  const oversized = run('\nexec(sys.argv[2], {"__name__": "__main__"})\n', "x".repeat(65537));
  assert.equal(oversized.status, 0, oversized.stderr);
  assert.deepEqual(oversized.stdout.trim().split("\n").map((line) => JSON.parse(line)), [{ ready: true }, { error: "protocol" }]);
  const incompatible = run('\nlaya.__version__ = "0.0.0"\nexec(sys.argv[2], {"__name__": "__main__"})\n');
  assert.equal(incompatible.status, 0, incompatible.stderr);
  assert.deepEqual(JSON.parse(incompatible.stdout), { error: "startup" });
});

test("Python bridge accepts the maximum preset roster without expanding the question budget", (t) => {
  if (!requiresPython(t)) return;
  const presets = Array.from({ length: MAX_PRESETS }, (_, index) => ({ ...defaults.presets[0], id: `custom-${index}`,
    name: "Role ".repeat(16), description: "Purpose ".repeat(30), instructions: "Instructions ".repeat(600) }));
  const questions = { ...LAYA_QUESTIONS, ...presetQuestions(presets).questions };
  const result = run('\nexec(sys.argv[2], {"__name__": "__main__"})\n', JSON.stringify({ state: { request: "Review" }, questions }) + "\n");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n").map((line) => JSON.parse(line)), [{ ready: true }, { answers: { echo: "Review" } }]);
});
