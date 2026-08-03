import { useEffect, useState } from "react";
import { api, liveModelLabel, providerLabel } from "../api.js";
import type { GenerationConfig, GenerationModelOptions, GenerationResponse, PanelProps } from "../types.js";
import { Busy, PanelIcon } from "./Feedback.js";

export interface GenerationState {
  generation: GenerationConfig | null;
  generationModelOptions: GenerationModelOptions;
  setGeneration: (generation: GenerationConfig) => void;
  setGenerationModelOptions: (options: GenerationModelOptions) => void;
}

export function GenerationPanel({ panel, state }: { panel: PanelProps; state: GenerationState }) {
  const { busy, run } = panel;
  const { generation, generationModelOptions, setGeneration, setGenerationModelOptions } = state;
  const [generationDraft, setGenerationDraft] = useState({
    model: generation?.model ?? "",
    provider: generation?.provider ?? "command-code"
  });
  const providerOptions = Object.keys(generationModelOptions).length
    ? Object.keys(generationModelOptions)
    : ["command-code", "codex", "openrouter", "gemini", "ollama"];
  const selectedProviderModels = generationModelOptions[generationDraft.provider] ?? [];
  const selectedProviderHasModel = selectedProviderModels.includes(generationDraft.model);

  useEffect(() => {
    if (generation) setGenerationDraft({ model: generation.model, provider: generation.provider });
  }, [generation]);

  function saveGenerationConfig() {
    run(async () => {
      const response = await api<GenerationResponse>("/generation", {
        method: "PATCH",
        body: JSON.stringify({ model: generationDraft.model.trim(), provider: generationDraft.provider })
      });
      const savedGeneration = response.generation;
      setGeneration(savedGeneration);
      setGenerationModelOptions(response.providers ?? generationModelOptions);
      setGenerationDraft({ model: savedGeneration.model, provider: savedGeneration.provider });
    });
  }

  return (
    <section className="panel settings">
      <div className="panel-head">
        <h2 className="panel-title"><PanelIcon name="settings" />Generation</h2>
        {generation ? (
          <span className={generation.configured ? "pill pill--succeeded" : "pill pill--failed"}>
            {generation.configured ? `Live: ${liveModelLabel(generation)}` : `${providerLabel(generation.provider)} key missing`}
          </span>
        ) : null}
      </div>
      {generation ? <p className="model-live">Realtime generator: {liveModelLabel(generation)}</p> : null}
      <div className="settings-grid">
        <label>
          Provider
          <select
            value={generationDraft.provider}
            onChange={(event) => {
              const provider = event.target.value;
              const models = generationModelOptions[provider] ?? [];
              setGenerationDraft({ provider, model: models[0] ?? "" });
            }}
          >
            {providerOptions.map((provider) => (
              <option key={provider} value={provider}>{providerLabel(provider)}</option>
            ))}
          </select>
        </label>
        <label>
          Model
          <select value={generationDraft.model} onChange={(event) => setGenerationDraft({ ...generationDraft, model: event.target.value })}>
            {selectedProviderModels.map((model) => <option key={model} value={model}>{model}</option>)}
            {!selectedProviderHasModel && generationDraft.model ? <option value={generationDraft.model}>{generationDraft.model}</option> : null}
          </select>
        </label>
        <label>
          Custom model
          <input
            value={generationDraft.model}
            onChange={(event) => setGenerationDraft({ ...generationDraft, model: event.target.value })}
            placeholder={selectedProviderModels[0] ?? "model name"}
          />
        </label>
      </div>
      <button disabled={!generationDraft.model.trim() || busy} onClick={saveGenerationConfig}><Busy active={busy} />Save model</button>
    </section>
  );
}
