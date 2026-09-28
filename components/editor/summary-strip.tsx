"use client";

import type { AnalysisSummary } from "@/lib/types";

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[11px] uppercase tracking-wider text-ink-500">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold text-ink-50">
        {value}
        {hint ? <span className="ml-1 text-xs font-normal text-ink-400">{hint}</span> : null}
      </dd>
    </div>
  );
}

export function SummaryStrip({
  summary,
  issueCount,
}: {
  summary: AnalysisSummary;
  issueCount: number;
}) {
  return (
    <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      <Stat label="Issues found" value={String(issueCount)} />
      <Stat label="Words" value={summary.wordCount.toLocaleString()} />
      <Stat
        label="Avg sentence"
        value={String(summary.averageSentenceLength)}
        hint="words"
      />
      <Stat
        label="Readability"
        value={String(summary.readability.score)}
        hint={summary.readability.label}
      />
    </dl>
  );
}
