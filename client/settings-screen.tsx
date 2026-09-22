import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
} from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Text } from "react-native";
import {
  defaults,
  getSettingsRpc,
  saveSettingsRpc,
  type PublicSettings,
} from "../shared/settings";

export function SettingsScreen({ theme }: PluginSurfaceProps) {
  const getSettings = useRpc(getSettingsRpc);
  const saveSettings = useRpc(saveSettingsRpc);
  const loaded = useQuery({
    queryKey: ["auto-mode-for-paseo", "settings"],
    queryFn: () => getSettings({}),
  });
  const [draft, setDraft] = useState<PublicSettings & { apiKey: string }>({
    ...defaults,
    hasApiKey: false,
    apiKey: "",
  });
  const [formKey, setFormKey] = useState(0);

  useEffect(() => {
    if (loaded.data) {
      setDraft({ ...loaded.data, apiKey: "" });
      setFormKey((value) => value + 1);
    }
  }, [loaded.data]);

  const save = useMutation({
    mutationFn: () =>
      saveSettings({
        ...draft,
        apiKey: draft.apiKey,
      }),
    onSuccess: (values) => {
      setDraft({ ...values, apiKey: "" });
      setFormKey((value) => value + 1);
    },
  });

  const ready = loaded.status === "success";
  const errorText =
    loaded.error instanceof Error
      ? loaded.error.message
      : save.error instanceof Error
        ? save.error.message
        : null;

  return (
    <>
      <SettingsSection title="Classifier" info="Choose how each new message is classified. A failure stops the turn. The plugin never switches classifiers automatically.">
        <SettingsCard>
          <SettingsSelect label="Classifier" value={draft.classifier}
            options={[{ label: "Jev (TypeSafe API)", value: "jev" }, { label: "Laya (local, experimental)", value: "laya" }]}
            onValueChange={(classifier) => setDraft((current) => ({ ...current, classifier }))} disabled={!ready} />
        </SettingsCard>
      </SettingsSection>
      {draft.classifier === "jev" ? (
      <SettingsSection
        title="TypeSafe"
        info="Each new message and up to six recent user messages, answers, or plans (1,000 characters each) are sent to TypeSafe. Select Auto or a manual model in the composer. The key is stored in ~/.paseo/auto-mode-for-paseo.local.json."
      >
        <SettingsCard>
          <SettingsInput
            key={`apiKey-${formKey}`}
            label="API key"
            hint={draft.hasApiKey ? "A key is already stored. Leave blank to keep it." : "Or set TYPESAFE_API_KEY on the daemon."}
            initialValue={draft.apiKey}
            onChangeText={(apiKey) => setDraft((current) => ({ ...current, apiKey }))}
            placeholder="ts-..."
            secureTextEntry
            disabled={!ready}
          />
          <SettingsInput
            key={`model-${formKey}`}
            label="Model"
            initialValue={draft.model}
            onChangeText={(model) => setDraft((current) => ({ ...current, model }))}
            placeholder="jev-latest"
            disabled={!ready}
          />
        </SettingsCard>
      </SettingsSection>
      ) : (
      <SettingsSection title="Laya" info="Classify locally with Python and Laya 0.3.5. No TypeSafe key is needed. Models download on first use. Oversized context stops the turn. Quality for this routing task is experimental.">
        <SettingsCard>
          <SettingsInput key={`layaPython-${formKey}`} label="Python executable"
            hint="Use the Python executable in the environment where Laya is installed. Do not include command arguments."
            initialValue={draft.layaPython} onChangeText={(layaPython) => setDraft((current) => ({ ...current, layaPython }))} disabled={!ready} />
          <SettingsInput key={`layaCache-${formKey}`} label="Model cache"
            hint="Keep the model cache in the plugin directory. The Windows installer configures this field."
            initialValue={draft.layaCache} onChangeText={(layaCache) => setDraft((current) => ({ ...current, layaCache }))} disabled={!ready} />
          <SettingsSelect label="Laya model" value={draft.layaModel}
            options={[{ label: "Multilingual (includes Portuguese)", value: "multilingual" }, { label: "English", value: "english" }, { label: "Typed decisions (specialized)", value: "typed-decisions" }]}
            onValueChange={(layaModel) => setDraft((current) => ({ ...current, layaModel }))} disabled={!ready} />
          <SettingsSelect label="Device" value={draft.layaDevice}
            options={[{ label: "CPU", value: "cpu" }, { label: "CUDA", value: "cuda" }, { label: "Automatic", value: "auto" }]}
            onValueChange={(layaDevice) => setDraft((current) => ({ ...current, layaDevice }))} disabled={!ready} />
        </SettingsCard>
      </SettingsSection>
      )}
      <SettingsSection
        title="Auto Mode for Paseo"
        info="Choose the model fallback for each task category. The classifier chooses effort on every new turn; an effort value here is used only when its answer is unavailable."
      >
        <SettingsCard>
          <SettingsInput
            key={`autoCodexModelStaff-${formKey}`}
            label="Architecture"
            initialValue={draft.autoCodexModelStaff}
            onChangeText={(autoCodexModelStaff) =>
              setDraft((current) => ({ ...current, autoCodexModelStaff }))
            }
            placeholder="gpt-6-astra"
            disabled={!ready}
          />
          <SettingsInput
            key={`autoCodexModelReview-${formKey}`}
            label="Review"
            initialValue={draft.autoCodexModelReview}
            onChangeText={(autoCodexModelReview) =>
              setDraft((current) => ({ ...current, autoCodexModelReview }))
            }
            placeholder="gpt-6-astra"
            disabled={!ready}
          />
          <SettingsInput
            key={`autoCodexModelCheap-${formKey}`}
            label="Mechanical tasks"
            initialValue={draft.autoCodexModelCheap}
            onChangeText={(autoCodexModelCheap) =>
              setDraft((current) => ({ ...current, autoCodexModelCheap }))
            }
            placeholder="gpt-5.6-luna"
            disabled={!ready}
          />
          <SettingsInput
            key={`autoCodexModelStandard-${formKey}`}
            label="Standard implementation"
            initialValue={draft.autoCodexModelStandard}
            onChangeText={(autoCodexModelStandard) =>
              setDraft((current) => ({ ...current, autoCodexModelStandard }))
            }
            placeholder="gpt-5.6-terra"
            disabled={!ready}
          />
          <SettingsInput
            key={`autoCodexModelLead-${formKey}`}
            label="Complex implementation"
            initialValue={draft.autoCodexModelLead}
            onChangeText={(autoCodexModelLead) =>
              setDraft((current) => ({ ...current, autoCodexModelLead }))
            }
            placeholder="gpt-5.6-sol"
            disabled={!ready}
          />
          <SettingsInput
            key={`autoCodexEffortStaff-${formKey}`}
            label="Architecture fallback effort"
            initialValue={draft.autoCodexEffortStaff}
            onChangeText={(autoCodexEffortStaff) =>
              setDraft((current) => ({ ...current, autoCodexEffortStaff }))
            }
            placeholder="xhigh"
            disabled={!ready}
          />
          <SettingsInput
            key={`autoCodexEffortReview-${formKey}`}
            label="Review fallback effort"
            initialValue={draft.autoCodexEffortReview}
            onChangeText={(autoCodexEffortReview) =>
              setDraft((current) => ({ ...current, autoCodexEffortReview }))
            }
            placeholder="high"
            disabled={!ready}
          />
          <SettingsInput
            key={`autoCodexEffortCheap-${formKey}`}
            label="Mechanical tasks fallback effort"
            initialValue={draft.autoCodexEffortCheap}
            onChangeText={(autoCodexEffortCheap) =>
              setDraft((current) => ({ ...current, autoCodexEffortCheap }))
            }
            placeholder="low"
            disabled={!ready}
          />
          <SettingsInput
            key={`autoCodexEffortStandard-${formKey}`}
            label="Standard implementation fallback effort"
            initialValue={draft.autoCodexEffortStandard}
            onChangeText={(autoCodexEffortStandard) =>
              setDraft((current) => ({ ...current, autoCodexEffortStandard }))
            }
            placeholder="medium"
            disabled={!ready}
          />
          <SettingsInput
            key={`autoCodexEffortLead-${formKey}`}
            label="Complex implementation fallback effort"
            initialValue={draft.autoCodexEffortLead}
            onChangeText={(autoCodexEffortLead) =>
              setDraft((current) => ({ ...current, autoCodexEffortLead }))
            }
            placeholder="high"
            disabled={!ready}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Thresholds" info="Thresholds refine the lane after the classifier has identified an explicit discussion, review, or implementation intent.">
        <SettingsCard>
          <SettingsInput
            key={`thresholdStaff-${formKey}`}
            label="Architecture"
            initialValue={String(draft.thresholdStaff)}
            onChangeText={(text) =>
              setDraft((current) => ({ ...current, thresholdStaff: Number(text) || 0 }))
            }
            disabled={!ready}
          />
          <SettingsInput
            key={`thresholdCheap-${formKey}`}
            label="Mechanical tasks"
            initialValue={String(draft.thresholdCheap)}
            onChangeText={(text) =>
              setDraft((current) => ({ ...current, thresholdCheap: Number(text) || 0 }))
            }
            disabled={!ready}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Save">
        <SettingsCard>
          <SettingsAction
            label={save.isSuccess ? "Saved" : "Write settings on this daemon"}
            actionLabel={save.isPending ? "Savingâ€¦" : "Save"}
            disabled={!ready || save.isPending}
            onPress={() => {
              void save.mutateAsync();
            }}
          />
        </SettingsCard>
      </SettingsSection>
      {errorText ? <Text style={{ color: theme.colors.statusDanger }}>{errorText}</Text> : null}
    </>
  );
}
