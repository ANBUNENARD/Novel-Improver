"use client";

/**
 * Side-by-side view of the rewrite.
 *
 * Each paragraph of the reader's chapter sits beside the paragraph it became,
 * with the findings that drove the change underneath. A change is kept or undone
 * one paragraph at a time, and Copy and Download export exactly what was kept.
 * That control is the point: a rewrite you cannot inspect is a rewrite you
 * cannot trust.
 */

import { useMemo } from "react";

import { CATEGORY_LABELS } from "@/lib/types";
import type { Change, CorrectionResult } from "@/lib/types";

/** Accent per category, so a finding's kind is readable without the label. */
const CATEGORY_STYLES: Record<Change["notes"][number]["category"], string> = {
  grammar: "text-accent-400",
  spelling: "text-accent-400",
  punctuation: "text-accent-400",
  clarity: "text-warn-400",
  style: "text-warn-400",
  repetition: "text-warn-400",
  structure: "text-good-400",
  pov: "text-accent-300",
};

export interface DiffViewProps {
  result: CorrectionResult;
  /** Indices the reader has undone. Lifted so Copy and Download agree with this. */
  reverted: Set<number>;
  onRevertedChange: (reverted: Set<number>) => void;
}

export function DiffView({ result, reverted, onRevertedChange }: DiffViewProps) {
  const changed = useMemo(
    () => result.changes.filter((change) => !change.unchanged),
    [result.changes],
  );

  const accepted = useMemo(
    () => new Set(result.changes.map((change) => change.index).filter((index) => !reverted.has(index))),
    [result.changes, reverted],
  );

  const toggle = (index: number) => {
    const next = new Set(reverted);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    onRevertedChange(next);
  };

  const revertAll = () => {
    onRevertedChange(
      new Set(result.changes.filter((change) => !change.unchanged).map((change) => change.index)),
    );
  };

  const acceptAll = () => onRevertedChange(new Set());

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-ink-500">
          {changed.length === 0
            ? "The chapter came back unchanged."
            : `${changed.length} of ${result.changes.length} paragraphs rewritten. Keep or undo each one.`}
        </p>

        {changed.length > 0 ? (
          <div className="flex items-center gap-1.5">
            <button type="button" onClick={acceptAll} className="chip">
              Keep all
            </button>
            <button type="button" onClick={revertAll} className="chip">
              Undo all
            </button>
          </div>
        ) : null}
      </div>

      <div className="space-y-3">
        {result.changes.map((change) => {
          const isKept = accepted.has(change.index);
          const rows = [
            { label: "Original", text: change.before, tone: "text-ink-400" },
            { label: "Rewritten", text: change.after, tone: "text-ink-100" },
          ];

          return (
            <article
              key={change.index}
              data-change={change.index}
              data-unchanged={change.unchanged ? "true" : "false"}
              data-kept={isKept ? "true" : "false"}
              className={`card p-3 transition-opacity ${change.unchanged ? "opacity-70" : ""}`}
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-[11px] uppercase tracking-wider text-ink-500">
                  Paragraph {change.index + 1}
                </span>

                {change.unchanged ? (
                  <span className="text-[11px] uppercase tracking-wider text-ink-500">Unchanged</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => toggle(change.index)}
                    aria-pressed={isKept}
                    className="chip"
                  >
                    {isKept ? "Kept" : "Undone"}
                  </button>
                )}
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                {rows.map((row) => (
                  <div
                    key={row.label}
                    className="rounded-md border border-ink-700 bg-ink-900/60 p-2.5"
                  >
                    <span className="text-[11px] uppercase tracking-wider text-ink-500">
                      {row.label}
                    </span>
                    <p
                      className={`prose-editor mt-1 font-serif text-[14px] leading-relaxed ${row.tone} ${
                        change.unchanged ? "" : row.label === "Original" ? "line-through decoration-ink-600" : ""
                      }`}
                    >
                      {row.text}
                    </p>
                  </div>
                ))}
              </div>

              {change.notes.length > 0 && isKept ? (
                <ul className="mt-2 space-y-1.5">
                  {change.notes.map((note, position) => (
                    <li key={`${change.index}-${position}`} className="text-xs leading-relaxed">
                      <span
                        className={`font-semibold uppercase tracking-wider ${CATEGORY_STYLES[note.category]}`}
                      >
                        {CATEGORY_LABELS[note.category]}
                      </span>
                      <span className="text-ink-200"> — {note.title}.</span>
                      <span className="text-ink-400"> {note.intended}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}
