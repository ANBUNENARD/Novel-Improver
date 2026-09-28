"use client";

import type { SpeakerNote } from "@/lib/types";

/** How each basis is described, so the reader knows how confident the note is. */
const BASIS_LABELS: Record<SpeakerNote["basis"], string> = {
  tag: "named in the tag",
  beat: "from the action around it",
  carried: "carried from the last line",
  ambiguous: "unclear",
};

export function SpeakerList({ speakers }: { speakers: SpeakerNote[] }) {
  if (speakers.length === 0) return null;

  const unknown = speakers.filter((note) => !note.speaker).length;

  return (
    <div className="rounded-lg border border-ink-700 bg-ink-900/50 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold text-ink-100">Who is speaking</h4>
        <p className="text-xs text-ink-500">
          {speakers.length} {speakers.length === 1 ? "line" : "lines"}
          {unknown > 0 ? ` · ${unknown} unclear` : ""}
        </p>
      </div>

      <ul className="mt-3 space-y-1.5">
        {speakers.map((note) => (
          <li
            key={note.index}
            className="flex flex-col gap-x-2 gap-y-0.5 sm:flex-row sm:flex-wrap sm:items-baseline"
          >
            <span
              className={
                note.speaker
                  ? "font-medium text-accent-400 sm:min-w-[7rem] sm:shrink-0"
                  : "text-warn-400 sm:min-w-[7rem] sm:shrink-0"
              }
            >
              {note.speaker ?? "Unclear"}
            </span>
            <span className="prose-editor min-w-0 flex-1 font-serif text-[14px] leading-relaxed text-ink-200">
              “{note.line}”
            </span>
            <span className="text-[11px] uppercase tracking-wider text-ink-500 sm:shrink-0">
              {BASIS_LABELS[note.basis]}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
