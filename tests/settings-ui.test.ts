import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import ts from "typescript";
import * as settings from "../shared/settings";

// Render the actual component with host UI primitives represented as elements.
// This checks conditional fields without a running native Paseo client.
function render(classifier: "jev" | "laya") {
  const source = readFileSync("client/settings-screen.tsx", "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText;
  const element = (type: unknown, props: unknown) => ({ type, props });
  const exports: Record<string, any> = {};
  runInNewContext(code, { exports, require(name: string) {
    if (name === "react/jsx-runtime") return { jsx: element, jsxs: element };
    if (name === "react") return { useEffect() {}, useState(initial: any) { return [typeof initial === "object" ? { ...initial, classifier } : initial, () => {}]; } };
    if (name === "@getpaseo/plugin/client") return { useRpc: () => () => {} };
    if (name === "@getpaseo/plugin/client/ui") return { SettingsSection: "section", SettingsCard: "card", SettingsInput: "input", SettingsSelect: "select", SettingsAction: "action" };
    if (name === "@tanstack/react-query") return { useQuery: () => ({ status: "success" }), useMutation: () => ({}) };
    if (name === "react-native") return { Text: "text" };
    if (name === "../shared/settings") return settings;
    throw new Error("Unexpected import: " + name);
  } });
  const labels: string[] = [];
  function visit(node: any): void {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node.props?.label) labels.push(node.props.label);
    visit(node.props?.children);
  }
  visit(exports.SettingsScreen({ theme: { colors: { statusDanger: "red" } } }));
  return labels;
}

test("settings ask for a TypeSafe key only with Jev selected", () => {
  const jev = render("jev");
  assert.ok(jev.includes("API key"));
  assert.ok(!jev.includes("Python executable"));
  const laya = render("laya");
  assert.ok(!laya.includes("API key"));
  assert.ok(!laya.includes("Model"));
  assert.ok(laya.includes("Python executable"));
  assert.ok(laya.includes("Laya model"));
  assert.ok(laya.includes("Device"));
});
