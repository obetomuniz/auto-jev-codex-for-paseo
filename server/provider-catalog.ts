import type { PaseoApi } from "@getpaseo/client";
import { catalogSchema } from "../shared/provider-catalog";

export async function providerCatalog(paseo: PaseoApi) {
  let snapshot = await paseo.providers.listAvailable();
  if (snapshot.error) throw new Error(snapshot.error);
  const nativeProviders = () => snapshot.providers.filter((entry) => entry.provider !== "auto-mode-for-paseo");
  const requested = nativeProviders().map((entry) => entry.provider);
  if (requested.length) {
    const refresh = await paseo.providers.refresh({ providers: requested });
    if (!refresh.acknowledged) throw new Error("Paseo could not refresh the provider catalog. Try again.");
  }
  // Refresh only acknowledges the request. Discovery continues in the daemon.
  await paseo.providers.waitForReady({ timeoutMs: 20_000 });
  snapshot = await paseo.providers.listAvailable();
  if (snapshot.error) throw new Error(snapshot.error);
  const providers = nativeProviders();
  const entries = await Promise.all(providers
    .map(async (entry) => {
      try {
        if (!entry.available) return { id: entry.provider, label: entry.provider, models: [], error: entry.error ?? "This provider is not available on the daemon." };
        const [result, modes] = await Promise.all([
          paseo.providers.listModels(entry.provider), paseo.providers.listModes(entry.provider).catch(() => ({ modes: [] })),
        ]);
        return { id: entry.provider, label: entry.provider, error: result.error ?? undefined,
          modes: ("error" in modes && modes.error ? [] : modes.modes ?? []).map(({ id, label }) => ({ id, label })),
          models: (result.error ? [] : result.models ?? []).filter((model) => model.isSelectable !== false).map((model) => ({
            id: model.id, label: model.label, efforts: (model.thinkingOptions ?? []).map(({ id, label }) => ({ id, label })),
          })),
        };
      } catch (error) {
        return { id: entry.provider, label: entry.provider, models: [], error: error instanceof Error ? error.message : "Could not load provider models." };
      }
    }));
  return catalogSchema.parse(entries);
}
