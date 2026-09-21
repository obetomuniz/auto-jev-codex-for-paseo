import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SettingsScreen } from "./client/settings-screen";

export default function contribute(client: PluginClientContext) {
  return client.addSettingsScreen({
    id: "auto-jev-codex-for-paseo",
    title: "Auto Jev-Codex for Paseo",
    icon: "GitBranch",
    Component: SettingsScreen,
  });
}
