import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SettingsScreen } from "./client/settings-screen";

export default function contribute(client: PluginClientContext) {
  return client.addSettingsScreen({
    id: "auto-mode-for-paseo",
    title: "Auto Mode for Paseo",
    icon: "GitBranch",
    Component: SettingsScreen,
  });
}
