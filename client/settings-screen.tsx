import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import {
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
} from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Children, isValidElement, useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import { TASK_DEPTHS, TASK_DEPTH_LABELS } from "../shared/task-depth";
import { detectTaskTypesRpc, TASK_TYPES, TASK_TYPE_LABELS, type TaskType } from "../shared/task-types";
import {
  defaults,
  MAX_PRESETS,
  type Preset,
  getSettingsRpc,
  saveSettingsRpc,
  settingsSchema,
  type PublicSettings,
} from "../shared/settings";

import { getProviderCatalogRpc } from "../shared/provider-catalog";
import { assignedTaskTypes, missingDefaultPresets, restoreDefaultPresets } from "../shared/presets";
import { SettingsAutosave, type SaveState } from "./settings-autosave";
import { needsDetection, TaskTypeDetector, type DetectionState } from "./task-type-detection";
import { workModes } from "../shared/provider-modes";

// The host supports flush sections, but the plugin SDK omits this layout prop.
// Remove the section's page-level bottom margin when it sits inside a card.
const presetSectionLayout = { flush: true };
const settingsQueryKey = ["auto-mode-for-paseo", "settings"];

export function SettingsScreen({ theme }: PluginSurfaceProps) {
  const queryClient = useQueryClient();
  const getSettings = useRpc(getSettingsRpc);
  const getProviders = useRpc(getProviderCatalogRpc);
  const catalog = useQuery({ queryKey: ["auto-mode-for-paseo", "providers"], queryFn: () => getProviders({}), staleTime: 60_000, refetchOnWindowFocus: false });
  const saveSettings = useRpc(saveSettingsRpc);
  const detectTypes = useRpc(detectTaskTypesRpc);
  const loaded = useQuery({
    queryKey: settingsQueryKey,
    queryFn: () => getSettings({}),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const [draft, setDraft] = useState<PublicSettings>({
    ...defaults,
    hasApiKey: false,
    ...loaded.data,
  });
  const [hydrated, setHydrated] = useState(Boolean(loaded.data));
  const [saveState, setSaveState] = useState<SaveState>({ saving: false, pending: false, error: false });
  const [keyDraft, setKeyDraft] = useState("");
  const [keySaving, setKeySaving] = useState(false);
  const [keyError, setKeyError] = useState<string | undefined>();
  const [detection, setDetection] = useState<Record<string, DetectionState>>({});
  const writerRef = useRef<SettingsAutosave | null>(null);
  const draftRef = useRef(draft);
  const detectorRef = useRef<TaskTypeDetector | null>(null);
  if (!writerRef.current && loaded.data) writerRef.current = new SettingsAutosave(loaded.data, (values) => saveSettings(values), (values) => {
    queryClient.setQueryData(settingsQueryKey, values);
    // Save responses update the cache, never the fields currently being edited.
  });
  const writer = writerRef.current;

  useEffect(() => {
    if (loaded.data && !hydrated) {
      draftRef.current = loaded.data;
      setDraft(loaded.data);
      setHydrated(true);
    }
  }, [loaded.data, hydrated]);

  useEffect(() => {
    if (!writer) return;
    const unsubscribe = writer.subscribe(setSaveState);
    return () => { unsubscribe(); void writer.flush(); };
  }, [writer]);

  // Refs keep this stable for callbacks created in earlier renders.
  const updateDraft = (update: (current: PublicSettings) => PublicSettings) => {
    const next = update(draftRef.current);
    draftRef.current = next;
    setDraft(next);
    writerRef.current?.update(next);
    detectorRef.current?.update(next.presets);
  };

  useEffect(() => {
    if (!hydrated) return;
    const detector = new TaskTypeDetector(async (description) => (await detectTypes({ description })).taskTypes,
      (id, description, taskTypes) => updateDraft((current) => ({ ...current, presets: current.presets.map((preset) =>
        preset.id === id && needsDetection(preset) && preset.description.trim() === description ? { ...preset, taskTypes, taskTypesScope: description } : preset) })),
      setDetection);
    detectorRef.current = detector;
    detector.update(draftRef.current.presets);
    return () => { detector.dispose(); detectorRef.current = null; };
  }, [hydrated]);
  const commitKey = async () => {
    if (!writer || keySaving) return;
    setKeySaving(true);
    setKeyError(undefined);
    try {
      await writer.saveKey(keyDraft.trim());
      setKeyDraft("");
    } catch (error) {
      setKeyError(error instanceof Error ? error.message : "Could not save the API key. Try again.");
    } finally { setKeySaving(false); }
  };

  const ready = hydrated;
  const catalogLoading = catalog.isPending && !catalog.data;
  const validation = settingsSchema.safeParse(draft);
  const issues = validation.success ? [] : validation.error.issues;
  const fieldError = (...path: (string | number)[]) => issues.find((issue) =>
    issue.path.length === path.length && issue.path.every((part, index) => part === path[index]),
  )?.message;
  const missingDefaults = missingDefaultPresets(draft.presets);
  const updatePreset = (id: string, values: Partial<Preset>) => updateDraft((current) => ({
    ...current, presets: current.presets.map((preset) => preset.id === id ? { ...preset, ...values } : preset),
  }));

  if (!hydrated) return (
    <View style={{ minHeight: 240, alignItems: "center", justifyContent: "center", gap: 12 }} accessibilityState={{ busy: loaded.isPending }}>
      {loaded.error instanceof Error ? <>
        <Text style={{ color: theme.colors.statusDanger }}>{loaded.error.message}</Text>
        <SettingsButton theme={theme} label="Retry" onPress={() => { void loaded.refetch(); }} />
      </> : <>
        <ActivityIndicator color={theme.colors.foregroundMuted} accessibilityLabel="Loading settings" />
        <Text style={{ color: theme.colors.foregroundMuted }}>Loading settings...</Text>
      </>}
    </View>
  );

  return (
    <>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginLeft: 4, marginBottom: 24 }}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontSize: 20, lineHeight: 28, fontWeight: "600" }}>Settings</Text>
          <Text accessibilityLiveRegion="polite" style={{ color: saveState.error ? theme.colors.statusDanger : theme.colors.foregroundMuted, fontSize: 14, lineHeight: 20 }}>
            {saveState.error ? "Changes could not be saved. Retry."
              : saveState.saving || saveState.pending ? "Saving changes..."
              : issues.length ? "Complete the highlighted fields to save them. Other changes save automatically."
              : "Changes save automatically."}
          </Text>
        </View>
        {saveState.saving ? <ActivityIndicator size="small" color={theme.colors.foregroundMuted} /> : null}
        {saveState.error ? <SettingsButton theme={theme} label="Retry" onPress={() => { void writer?.flush(); }} /> : null}
      </View>
      <SettingsSection title="Classifier" info="Choose how each new message is classified. Jev is more accurate for Auto preset selection. Laya runs locally with lower accuracy. A failure stops the turn. The plugin never switches classifiers automatically.">
        <SettingsCard>
          <SettingsSelect label="Classifier" value={draft.classifier} error={fieldError("classifier")}
            options={[{ label: "Jev (TypeSafe API)", value: "jev" }, { label: "Laya (local, experimental)", value: "laya" }]}
            onValueChange={(classifier) => updateDraft((current) => ({ ...current, classifier }))} disabled={!ready} />
        </SettingsCard>
      </SettingsSection>
      {draft.classifier === "jev" ? (
      <SettingsSection
        title="TypeSafe"
        info="Each new message and up to six recent user messages, answers, or plans (1,000 characters each) are sent to TypeSafe. Select Auto or a preset in the composer. The key is stored in ~/.paseo/auto-mode-for-paseo.local.json."
      >
        <SettingsCard>
          <SettingsRow label="API key" error={keyError}
            hint={loaded.data?.hasApiKey ? "A key is stored. Enter a replacement to change it." : "Or set TYPESAFE_API_KEY on the daemon."}>
            <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <TextInput accessibilityLabel="API key" value={keyDraft} onChangeText={(value) => { setKeyDraft(value); setKeyError(undefined); }}
                placeholder="ts-..." placeholderTextColor={theme.colors.foregroundMuted} secureTextEntry autoCapitalize="none" autoCorrect={false}
                editable={ready && !keySaving}
                style={{ width: 180, maxWidth: "100%", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, fontSize: 14, color: theme.colors.foreground, backgroundColor: theme.colors.surface2 }} />
              {keyDraft.length > 0 ? <>
                <SettingsButton theme={theme} label="Cancel" accessibilityLabel="Cancel API key change" disabled={keySaving}
                  onPress={() => { setKeyDraft(""); setKeyError(undefined); }} />
                <SettingsButton theme={theme} label="Save" accessibilityLabel="Save API key" busy={keySaving} disabled={keySaving || !keyDraft.trim()}
                  onPress={() => { void commitKey(); }} />
              </> : null}
            </View>
          </SettingsRow>
          <SettingsInput
            label="Model"
            error={fieldError("model")}
            initialValue={draft.model}
            onChangeText={(model) => updateDraft((current) => ({ ...current, model }))}
            placeholder="jev-latest"
            disabled={!ready}
          />
        </SettingsCard>
      </SettingsSection>
      ) : (
      <SettingsSection title="Laya" info="Classify locally with Python and Laya 0.3.5. No TypeSafe key is needed. Models download on first use. Oversized context stops the turn. Quality for this routing task is experimental.">
        <SettingsCard>
          <SettingsInput label="Python executable"
            error={fieldError("layaPython")}
            hint="Use the Python executable in the environment where Laya is installed. Do not include command arguments."
            initialValue={draft.layaPython} onChangeText={(layaPython) => updateDraft((current) => ({ ...current, layaPython }))} disabled={!ready} />
          <SettingsInput label="Model cache"
            error={fieldError("layaCache")}
            hint="Keep the model cache in the plugin directory. The Windows installer configures this field."
            initialValue={draft.layaCache} onChangeText={(layaCache) => updateDraft((current) => ({ ...current, layaCache }))} disabled={!ready} />
          <SettingsSelect label="Laya model" value={draft.layaModel} error={fieldError("layaModel")}
            options={[{ label: "Multilingual (includes Portuguese)", value: "multilingual" }, { label: "English", value: "english" }, { label: "Typed decisions (specialized)", value: "typed-decisions" }]}
            onValueChange={(layaModel) => updateDraft((current) => ({ ...current, layaModel }))} disabled={!ready} />
          <SettingsSelect label="Device" value={draft.layaDevice} error={fieldError("layaDevice")}
            options={[{ label: "CPU", value: "cpu" }, { label: "CUDA", value: "cuda" }, { label: "Automatic", value: "auto" }]}
            onValueChange={(layaDevice) => updateDraft((current) => ({ ...current, layaDevice }))} disabled={!ready} />
        </SettingsCard>
      </SettingsSection>
      )}
      <SettingsSection title="Presets"
        info="A preset defines a responsibility, such as reviewing code or reporting progress. Auto picks the kind of work, then matches scopes and supported task depth among the presets used for it. Instructions tell the selected model how to work. Default and custom presets follow the same rules."
        trailing={
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
            <SettingsButton theme={theme} label="Restore" accessibilityLabel="Restore missing default presets"
              disabled={!ready || !missingDefaults.length || draft.presets.length + missingDefaults.length > MAX_PRESETS}
              onPress={() => updateDraft((current) => ({ ...current, presets: restoreDefaultPresets(current.presets) }))} />
            <SettingsButton theme={theme} label="Refresh" busy={catalog.isFetching} accessibilityLabel="Refresh available providers and models"
              disabled={catalog.isFetching} onPress={() => { void catalog.refetch(); }} />
          </View>
        }>
        {catalog.error instanceof Error ? <Text style={{ color: theme.colors.statusDanger }}>{catalog.error.message}</Text> : null}
        {fieldError("presets") ? <Text style={{ color: theme.colors.statusDanger }}>{fieldError("presets")}</Text> : null}
        {draft.presets.length + missingDefaults.length > MAX_PRESETS ?
          <Text style={{ color: theme.colors.foregroundMuted }}>Remove presets to make room before restoring defaults. The limit is {MAX_PRESETS}.</Text> : null}
        {!draft.presets.length ? <Text style={{ color: theme.colors.foregroundMuted }}>No presets. Add a preset or restore the defaults to start routing.</Text> : null}
        <View style={{ gap: 24 }}>
        {draft.presets.map((preset, index) => {
            const provider = catalog.data?.find((entry) => entry.id === preset.provider);
            const model = provider?.models.find((entry) => entry.id === preset.model);
            const modes = workModes(provider?.modes ?? []);
            const effortAvailable = model?.efforts.some((entry) => entry.id === preset.effort);
            const modelHint = catalogLoading ? undefined
              : !catalog.data ? "Refresh to load available models."
              : !provider ? "Select an available provider."
              : !provider.models.length ? "No models available. Check the provider connection and refresh."
              : preset.model && !model ? "The saved model is unavailable. Choose another model or refresh."
              : undefined;
            return (
            <View key={preset.id} style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, padding: 16, backgroundColor: theme.colors.surface1 }}>
            <SettingsSection {...presetSectionLayout} title={preset.name || "Preset"}
              trailing={<RemovePresetButton theme={theme} accessibilityLabel="Remove preset" disabled={!ready}
                onPress={() => updateDraft((current) => ({ ...current, presets: current.presets.filter((item) => item.id !== preset.id) }))} />}>
            <PresetFields key={preset.id} theme={theme}>
              <SettingsInput label="Name" initialValue={preset.name} error={fieldError("presets", index, "name")}
                onChangeText={(name) => updatePreset(preset.id, { name })} disabled={!ready} />
              <PresetScope theme={theme} value={preset.description} error={fieldError("presets", index, "description")}
                onChangeText={(description) => updatePreset(preset.id, { description })} disabled={!ready} />
              {preset.description.trim() ? <PresetTaskTypes theme={theme} preset={preset} state={detection[preset.id]}
                error={fieldError("presets", index, "taskTypes")} disabled={!ready}
                onToggle={(type) => {
                  const selected = assignedTaskTypes(preset) ?? [];
                  updatePreset(preset.id, { taskTypesAuto: false,
                    taskTypes: selected.includes(type) ? selected.filter((item) => item !== type) : TASK_TYPES.filter((item) => item === type || selected.includes(item)) });
                }}
                onDetect={() => { detectorRef.current?.retry(preset.id); updatePreset(preset.id, { taskTypesAuto: true, taskTypesScope: "" }); }} /> : null}
              <SettingsSelect label="Task depth" value={preset.taskDepth} error={fieldError("presets", index, "taskDepth")}
                hint="The most demanding work this setup can handle: Light, Standard, Deep or Expert. Auto matches scope among setups that support the required depth. This does not change the model's reasoning setting."
                options={TASK_DEPTHS.map((value) => ({ value, label: TASK_DEPTH_LABELS[value] }))}
                onValueChange={(taskDepth) => updatePreset(preset.id, { taskDepth })} disabled={!ready} />
              <SettingsSelect label="Status" value={preset.enabled ? "enabled" : "disabled"} error={fieldError("presets", index, "enabled")}
                options={[{ label: "Enabled", value: "enabled" }, { label: "Disabled", value: "disabled" }]}
                onValueChange={(value) => updatePreset(preset.id, { enabled: value === "enabled" })} disabled={!ready} />
              <SettingsSelect label="Provider" value={catalogLoading || provider ? preset.provider : ""} error={fieldError("presets", index, "provider") ?? provider?.error}
                options={catalogLoading ? [{ label: "Loading...", value: preset.provider }] : [...(!provider ? [{ label: "Choose a provider", value: "" }] : []),
                  ...(catalog.data ?? []).map((entry) => ({ label: entry.label, value: entry.id }))]}
                onValueChange={(value) => {
                  updatePreset(preset.id, { provider: value, model: "", effort: "", workMode: "" });
                }} disabled={!ready || !catalog.data} />
              <SettingsSelect label="Available models" value={catalogLoading || model ? preset.model : ""} hint={modelHint} error={fieldError("presets", index, "model")}
                options={catalogLoading ? [{ label: "Loading...", value: preset.model }] : [...(!model ? [{ label: "Choose a model", value: "" }] : []),
                  ...(provider?.models ?? []).map((entry) => ({ label: entry.label, value: entry.id }))]}
                onValueChange={(value) => {
                  updatePreset(preset.id, { model: value, effort: "" });
                }} disabled={!ready || !provider?.models.length} />
              {catalogLoading || (model?.efforts.length ?? 0) > 0 ? <SettingsSelect label="Reasoning effort" value={catalogLoading || effortAvailable ? preset.effort : ""} error={fieldError("presets", index, "effort")}
                hint={model && preset.effort && !effortAvailable ? "The saved setting is no longer supported. The model default will be used." : undefined}
                options={catalogLoading ? [{ label: "Loading...", value: preset.effort }] : [{ label: "Provider default", value: "" }, ...(model?.efforts ?? []).map((entry) => ({ label: entry.label, value: entry.id }))]}
                onValueChange={(effort) => updatePreset(preset.id, { effort })} disabled={!ready || catalogLoading} /> : null}
              {modes.length > 0 ? <SettingsSelect label="Work mode" value={modes.some((mode) => mode.id === preset.workMode) ? preset.workMode : ""}
                options={[{ label: "Automatic", value: "" }, ...modes.map((mode) => ({ label: mode.label, value: mode.id }))]}
                hint="Choose how this preset works. Planning uses the provider's planning mode when available."
                onValueChange={(workMode) => updatePreset(preset.id, { workMode })} disabled={!ready} /> : null}
              <SettingsInput label="Instructions" initialValue={preset.instructions} error={fieldError("presets", index, "instructions")}
                onChangeText={(instructions) => updatePreset(preset.id, { instructions })} disabled={!ready} />
            </PresetFields>
            </SettingsSection>
            </View>
          ); })}
          <SettingsButton theme={theme} label="Create preset" variant="add" disabled={!ready || draft.presets.length >= MAX_PRESETS}
            onPress={() => updateDraft((current) => ({ ...current, presets: [...current.presets, { id: "custom-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8), name: "Custom preset", description: "", taskDepth: "medium", provider: catalog.data?.[0]?.id ?? "codex", model: "", effort: "", workMode: "", instructions: "", enabled: true, taskTypes: [], taskTypesAuto: true, taskTypesScope: "" }] }))} />
          {draft.presets.length >= MAX_PRESETS ? <Text style={{ color: theme.colors.foregroundMuted }}>You have reached the limit of {MAX_PRESETS} presets.</Text> : null}
        </View>
      </SettingsSection>
    </>
  );
}

function PresetScope({ theme, value, error, onChangeText, disabled }: {
  theme: PluginSurfaceProps["theme"]; value: string; error?: string; onChangeText(text: string): void; disabled: boolean;
}) {
  return (
    <View style={{ paddingVertical: 16, gap: 8 }}>
      <Text style={{ color: theme.colors.foreground }}>Scope</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        Describe the tasks this preset owns and its limits. Auto uses this complete scope. Leave empty for manual selection only.
      </Text>
      <TextInput accessibilityLabel="Scope" value={value} onChangeText={onChangeText} editable={!disabled}
        multiline maxLength={240} placeholder="When should Auto choose this preset?"
        placeholderTextColor={theme.colors.foregroundMuted}
        style={{ color: theme.colors.foreground, backgroundColor: theme.colors.surface2, borderRadius: 6,
          padding: 12, minHeight: 88, fontSize: 13, textAlignVertical: "top" }} />
      {error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{error}</Text> : null}
    </View>
  );
}

function PresetTaskTypes({ theme, preset, state, error, disabled, onToggle, onDetect }: {
  theme: PluginSurfaceProps["theme"]; preset: Preset; state?: DetectionState; error?: string; disabled: boolean;
  onToggle(type: TaskType): void; onDetect(): void;
}) {
  const selected = assignedTaskTypes(preset) ?? [];
  const status = state?.detecting ? "Detecting from scope..."
    : state?.error ? `Could not detect task types. ${state.error}`
    : !preset.taskTypesAuto ? "Set manually."
    : needsDetection(preset) ? "Waiting to detect from scope."
    : "Detected from scope. Select a type to set them manually.";
  return (
    <View style={{ paddingVertical: 16, gap: 8 }}>
      <Text style={{ color: theme.colors.foreground }}>Used for</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        Auto first picks the kind of work, then compares scopes among the presets used for it.
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {TASK_TYPES.map((type) => {
          const checked = selected.includes(type);
          return (
            <Pressable key={type} accessibilityRole="checkbox" accessibilityLabel={`Used for ${TASK_TYPE_LABELS[type]}`}
              accessibilityState={{ checked, disabled }} disabled={disabled} onPress={() => onToggle(type)}
              style={({ pressed }) => ({ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1,
                borderColor: checked ? theme.colors.foreground : theme.colors.border,
                backgroundColor: checked || pressed ? theme.colors.surface2 : "transparent", opacity: disabled ? 0.45 : 1 })}>
              <Text style={{ color: checked ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: 13, fontWeight: checked ? "600" : "400" }}>
                {TASK_TYPE_LABELS[type]}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {state?.detecting ? <ActivityIndicator size="small" color={theme.colors.foregroundMuted} /> : null}
        <Text accessibilityLiveRegion="polite" style={{ flex: 1, color: state?.error ? theme.colors.statusDanger : theme.colors.foregroundMuted, fontSize: 12 }}>{status}</Text>
        {!state?.detecting && (!preset.taskTypesAuto || state?.error) ?
          <SettingsButton theme={theme} label="Detect from scope" accessibilityLabel="Detect task types from scope" disabled={disabled} onPress={onDetect} /> : null}
      </View>
      {error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{error}</Text> : null}
    </View>
  );
}

function PresetFields({ theme, children }: { theme: PluginSurfaceProps["theme"]; children: ReactNode }) {
  return (
    <View>
      {Children.toArray(children).map((child, index) => (
        <View key={isValidElement(child) ? child.key ?? index : index}>
          {index > 0 ? <View style={{ height: 1, backgroundColor: theme.colors.border, opacity: 0.6 }} /> : null}
          {child}
        </View>
      ))}
    </View>
  );
}

function RemovePresetButton({ theme, accessibilityLabel, disabled, onPress }: {
  theme: PluginSurfaceProps["theme"];
  accessibilityLabel: string;
  disabled: boolean;
  onPress(): void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ position: "relative", zIndex: 1 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ disabled }}
        disabled={disabled} onPress={onPress}
        onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        style={({ pressed }) => ({
          width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: 8,
          backgroundColor: pressed || hovered || focused ? theme.colors.surface2 : "transparent",
          opacity: disabled ? 0.45 : 1,
        })}>
        <Icon name="Trash2" size={18} color={theme.colors.statusDanger} />
      </Pressable>
      {(hovered || focused) && !disabled ? (
        // Paseo's Tooltip is internal. Match its top offset, spacing, typography,
        // radius, and shadow with the surface colors exposed to plugins.
        <View pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
          style={{ position: "absolute", right: 0, bottom: 44, maxWidth: 280, paddingHorizontal: 8, paddingVertical: 4,
            borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface2,
            boxShadow: "0px 4px 8px rgba(0, 0, 0, 0.20)" }}>
          <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 14, lineHeight: 19.6 }}>{accessibilityLabel}</Text>
        </View>
      ) : null}
    </View>
  );
}

function SettingsButton({ theme, label, accessibilityLabel = label, disabled = false, busy = false, variant = "secondary", onPress }: {
  theme: PluginSurfaceProps["theme"];
  label: string;
  accessibilityLabel?: string;
  disabled?: boolean;
  busy?: boolean;
  variant?: "secondary" | "add";
  onPress(): void;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ disabled, busy }}
      disabled={disabled} onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row", alignItems: "center", justifyContent: "center", gap: variant === "add" ? 10 : 8,
        minHeight: variant === "add" ? 56 : 36,
        paddingHorizontal: variant === "add" ? 24 : 14, paddingVertical: variant === "add" ? 16 : 8,
        marginVertical: variant === "add" ? 8 : 0,
        borderWidth: 1, borderRadius: 8, borderColor: theme.colors.border,
        borderStyle: variant === "add" ? "dashed" : "solid",
        backgroundColor: pressed ? theme.colors.surface2 : theme.colors.surface1,
        opacity: disabled ? 0.45 : 1,
      })}>
      {variant === "add" ? (
        <View accessible={false} style={{ width: 16, height: 20 }}>
          <View style={{ position: "absolute", left: 2, top: 9, width: 12, height: 2, borderRadius: 1, backgroundColor: theme.colors.foreground }} />
          <View style={{ position: "absolute", left: 7, top: 4, width: 2, height: 12, borderRadius: 1, backgroundColor: theme.colors.foreground }} />
        </View>
      ) : null}
      <Text style={{ color: theme.colors.foreground, fontSize: variant === "add" ? 14 : 13, lineHeight: 20, fontWeight: "500", includeFontPadding: false, opacity: busy ? 0 : 1 }}>{label}</Text>
      {busy ? <ActivityIndicator color={theme.colors.foregroundMuted} style={{ position: "absolute" }} /> : null}
    </Pressable>
  );
}
