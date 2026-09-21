import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createAutoJevCodexProvider } from "./server/provider";
import { loadSettings, saveSettings } from "./server/settings-store";
import { getSettingsRpc, saveSettingsRpc, toPublic } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createAutoJevCodexProvider());

  server.handle(getSettingsRpc, async () => toPublic(await loadSettings()));
  server.handle(saveSettingsRpc, (values) => saveSettings(values));

  // Provider and RPC registrations are scoped to the plugin connection. The
  // host removes them when this contribution is disposed; the lifecycle API
  // still requires an explicit cleanup callback.
  return () => undefined;
}
