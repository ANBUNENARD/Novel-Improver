"use client";

/**
 * Model picker.
 *
 * Only the models the configured provider can actually serve are offered, taken
 * from /api/health. The list is served even with no key on the server, because
 * the reader can paste one into the page, so this stays a real choice either
 * way.
 */

import { useEffect, useState } from "react";

export interface ModelChoice {
  id: string;
  label: string;
  note: string;
}

interface ModelPickerProps {
  value: string;
  onChange: (model: string) => void;
}

export function ModelPicker({ value, onChange }: ModelPickerProps) {
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [configured, setConfigured] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/health")
      .then((response) => response.json())
      .then((body: { llm?: { models?: ModelChoice[]; defaultModel?: string | null } }) => {
        if (cancelled) return;
        setModels(body.llm?.models ?? []);
        setConfigured(body.llm?.defaultModel ?? null);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (!loaded) {
    return (
      <p className="text-xs text-ink-500">Checking which models are available…</p>
    );
  }

  if (models.length === 0) {
    return (
      <p className="text-xs text-ink-500">
        No models are available on this server. Set LLM_PROVIDER and reload.
      </p>
    );
  }

  // The reader can leave the row alone, which means "run the model the server is
  // configured with". `defaultModel` is that one, and it is what gets pressed.
  const active = models.find((model) => model.id === value) ?? models.find((model) => model.id === configured) ?? models[0];

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-[11px] uppercase tracking-wider text-ink-500">Model</span>
      {models.map((model) => (
        <button
          key={model.id}
          type="button"
          onClick={() => onChange(model.id)}
          data-active={model.id === active.id}
          className="chip"
          aria-pressed={model.id === active.id}
          title={model.note}
        >
          {model.label}
        </button>
      ))}
      <span className="ml-1 text-xs text-ink-500">{active.note}</span>
    </div>
  );
}
