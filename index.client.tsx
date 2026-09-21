import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SettingsScreen } from "./client/settings-screen";

export default function contribute(client: PluginClientContext) {
  return client.addSettingsScreen({
    id: "auto-jev-codex",
    title: "Auto Jev-Codex",
    icon: "GitBranch",
    Component: SettingsScreen,
  });
}
