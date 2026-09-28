"use client";

import type { Suggestion } from "@/lib/types";
import { CATEGORY_LABELS } from "@/lib/types";

/** Accent per category, so a card's category is readable without the label. */
const CATEGORY_STYLES: Record<Suggestion["category"], string> = {
  grammar: "border-l-accent-500",
  spelling: "border-l-accent-500",
  punctuation: "border-l-accent-500",
  clarity: "border-l-warn-500",
  style: "border-l-warn-500",
  repetition: "border-l-warn-500",
  structure: "border-l-good-500",
  pov: "border-l-accent-400",
};

export function SuggestionCard({
  suggestion,
  index,
}: {
  suggestion: Suggestion;
  index: number;
}) {
  return (
    <li
      className={`card border-l-[3px] p-4 ${CATEGORY_STYLES[suggestion.category]}`}
      style={{ animationDelay: `${Math.min(index, 12) * 40}ms` }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-md bg-ink-700/70 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-ink-300">
          {CATEGORY_LABELS[suggestion.category]}
        </span>
        <h4 className="text-sm font-semibold text-ink-50">{suggestion.title}</h4>
      </div>

      {suggestion.note ? (
        <p className="mt-2 text-sm leading-relaxed text-ink-300">{suggestion.note}</p>
      ) : null}

      <div className="mt-3 space-y-2 text-sm">
        <div className="rounded-md border border-ink-700 bg-ink-900/60 p-2.5">
          <span className="text-[11px] uppercase tracking-wider text-ink-500">Original</span>
          <p className="prose-editor mt-1 font-serif leading-relaxed text-ink-400 line-through decoration-ink-600">
            {suggestion.original || "—"}
          </p>
        </div>

        {suggestion.suggestion ? (
          <div className="rounded-md border border-accent-600/40 bg-accent-500/10 p-2.5">
            <span className="text-[11px] uppercase tracking-wider text-accent-400">Suggested</span>
            <p className="prose-editor mt-1 font-serif leading-relaxed text-ink-100">
              {suggestion.suggestion}
            </p>
          </div>
        ) : null}
      </div>
    </li>
  );
}
