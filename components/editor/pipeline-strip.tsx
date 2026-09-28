"use client";

import { useState } from "react";

import type { PipelineReportEntry } from "@/lib/types";
import { PIPELINE_STAGE_DESCRIPTIONS, PIPELINE_STAGE_LABELS, PIPELINE_STAGES } from "@/lib/types";

/**
 * The ten stages of the polishing pass.
 *
 * Compact by default so the chapter is what draws the eye. Tapping a stage
 * opens the line describing what it did on this run, so a stage that was
 * skipped or that found nothing says so rather than implying work happened.
 */
export function PipelineStrip({ report }: { report: PipelineReportEntry[] }) {
  const [open, setOpen] = useState<string | null>(null);

  const byStage = new Map(report.map((entry) => [entry.stage, entry]));
  const ranCount = report.filter((entry) => entry.ran).length;

  return (
    <div className="rounded-lg border border-ink-700 bg-ink-900/50 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold text-ink-100">Polishing pass</h4>
        <p className="text-xs text-ink-500">
          {ranCount} of {PIPELINE_STAGES.length} stages ran
        </p>
      </div>

      <ol className="mt-3 flex flex-wrap gap-1.5">
        {PIPELINE_STAGES.map((stage, index) => {
          const entry = byStage.get(stage);
          const ran = entry?.ran ?? false;
          const isOpen = open === stage;

          return (
            <li key={stage}>
              <button
                type="button"
                onClick={() => setOpen(isOpen ? null : stage)}
                aria-expanded={isOpen}
                title={entry?.detail ?? PIPELINE_STAGE_DESCRIPTIONS[stage]}
                data-active={isOpen}
                className={`chip !px-2.5 !py-1 ${
                  ran
                    ? "border-good-500/50 text-good-400"
                    : "border-ink-600 text-ink-500 opacity-70"
                } ${isOpen ? "border-accent-500 text-accent-300" : ""}`}
              >
                <span aria-hidden className="tabular-nums opacity-60">
                  {index + 1}
                </span>
                {PIPELINE_STAGE_LABELS[stage]}
              </button>
            </li>
          );
        })}
      </ol>

      {open ? (
        <div className="mt-3 rounded-md border border-ink-700 bg-ink-950/50 p-3">
          <p className="text-xs font-semibold text-ink-200">
            {PIPELINE_STAGE_LABELS[open as (typeof PIPELINE_STAGES)[number]]}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-ink-400">
            {byStage.get(open as (typeof PIPELINE_STAGES)[number])?.detail ??
              PIPELINE_STAGE_DESCRIPTIONS[open as (typeof PIPELINE_STAGES)[number]]}
          </p>
        </div>
      ) : null}
    </div>
  );
}
