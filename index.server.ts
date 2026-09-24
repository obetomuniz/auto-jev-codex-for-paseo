import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createAutoModeProvider } from "./server/provider";
import { disposeLaya } from "./server/laya";
import { loadSettings, saveSettings } from "./server/settings-store";
import { getSettingsRpc, saveSettingsRpc, toPublic } from "./shared/settings";
import type { PaseoApi } from "@getpaseo/client";
import { getProviderCatalogRpc } from "./shared/provider-catalog";
import { providerCatalog } from "./server/provider-catalog";
import { detectTaskTypesRpc } from "./shared/task-types";
import { detectTaskTypes } from "./server/scope-types";

export default function contribute(server: PluginServerContext) {
  let paseo: PaseoApi | undefined;
  const bindHost = server.before("agent.session_open", (_input, context) => { paseo = context.paseo; });
  server.registerProvider(createAutoModeProvider(() => {
    if (!paseo) throw new Error("Paseo has not opened the plugin session yet.");
    return paseo;
  }));

  server.handle(getSettingsRpc, async () => toPublic(await loadSettings()));
  server.handle(saveSettingsRpc, (values) => saveSettings(values));
  server.handle(detectTaskTypesRpc, async ({ description }) => ({ taskTypes: await detectTaskTypes(description, await loadSettings()) }));
  server.handle(getProviderCatalogRpc, (_values, context) => providerCatalog(context.paseo));

  // Provider and RPC registrations are scoped to the plugin connection. The
  // host removes them when this contribution is disposed; the lifecycle API
  // still requires an explicit cleanup callback.
  return () => { bindHost(); disposeLaya(); };
}
