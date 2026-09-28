"use client";

import type { ContinuityNote } from "@/lib/types";

/** Only the lines worth showing; a full sentence is plenty of context. */
const MAX_CONTEXT = 160;

export function ContinuityList({ notes }: { notes: ContinuityNote[] }) {
  if (notes.length === 0) return null;

  return (
    <div className="rounded-lg border border-ink-700 bg-ink-900/50 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold text-ink-100">Continuity</h4>
        <p className="text-xs text-ink-500">
          {notes.length} {notes.length === 1 ? "name" : "names"} matched to the story bible
        </p>
      </div>

      <ul className="mt-3 space-y-1.5">
        {notes.map((note, index) => (
          <li
            key={`${note.canonical}-${note.raw}-${index}`}
            className="flex flex-col gap-x-2 gap-y-0.5 sm:flex-row sm:flex-wrap sm:items-baseline"
          >
            <span className="flex flex-wrap items-baseline gap-1.5 sm:min-w-[9rem] sm:shrink-0">
              {note.raw !== note.canonical ? (
                <>
                  <span className="font-medium text-warn-400 line-through decoration-warn-500/50">
                    {note.raw}
                  </span>
                  <span aria-hidden className="text-ink-500">
                    &rarr;
                  </span>
                </>
              ) : null}
              <span className="font-medium text-accent-400">{note.canonical}</span>
            </span>

            {note.note ? (
              <span className="min-w-0 flex-1 text-xs text-ink-400">{note.note}</span>
            ) : null}

            {note.context ? (
              <span className="prose-editor min-w-0 flex-1 font-serif text-[14px] leading-relaxed text-ink-200">
                {note.context.length > MAX_CONTEXT
                  ? `${note.context.slice(0, MAX_CONTEXT)}…`
                  : note.context}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
