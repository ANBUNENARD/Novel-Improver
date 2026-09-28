"use client";

/**
 * The continuity dictionary editor.
 *
 * Entries live in localStorage so a project keeps its cast between chapters.
 * The panel is the only place a name, alias, gender, or role is declared, and
 * the same entries are what the normaliser and the model prompt read.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { defaultBible, parseBibleText } from "@/lib/default-bible";
import { MAX_BIBLE_ENTRIES, normaliseBible } from "@/lib/story-bible";
import type { BibleEntry, BibleEntryKind, Gender, StoryBible } from "@/lib/types";
import { BIBLE_ENTRY_KINDS, BIBLE_KIND_LABELS } from "@/lib/types";

const STORAGE_KEY = "proselens:story-bible:v1";

const GENDER_OPTIONS: Array<{ value: Gender | ""; label: string }> = [
  { value: "", label: "Not stated" },
  { value: "female", label: "Female" },
  { value: "male", label: "Male" },
  { value: "other", label: "Other" },
];

let idCounter = 0;

function newId(): string {
  idCounter += 1;
  return `u${Date.now().toString(36)}${idCounter}`;
}

function blankEntry(): BibleEntry {
  return { id: newId(), kind: "character", name: "", aliases: [] };
}

function readStored(): StoryBible {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultBible();
    const parsed = normaliseBible(JSON.parse(raw));
    return parsed.entries.length > 0 ? parsed : defaultBible();
  } catch {
    return defaultBible();
  }
}

export function StoryBiblePanel({
  entries,
  onChange,
}: {
  entries: BibleEntry[];
  onChange: (entries: BibleEntry[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [draft, setDraft] = useState("");
  const [importMessage, setImportMessage] = useState<string | null>(null);

  // Loaded after mount so the server and the first client render agree.
  useEffect(() => {
    const stored = readStored();
    if (stored.entries.length > 0) onChange(stored.entries);
    // Runs once on mount: the stored dictionary replaces the shipped default.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commit = useCallback(
    (next: BibleEntry[]) => {
      onChange(next);
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ entries: next }));
      } catch {
        // Private browsing or a full quota. The chapter still runs; the
        // dictionary just will not survive a reload.
      }
    },
    [onChange],
  );

  const update = useCallback(
    (id: string, patch: Partial<BibleEntry>) => {
      commit(entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
    },
    [commit, entries],
  );

  const remove = useCallback(
    (id: string) => commit(entries.filter((entry) => entry.id !== id)),
    [commit, entries],
  );

  const add = useCallback(() => {
    if (entries.length >= MAX_BIBLE_ENTRIES) return;
    commit([...entries, blankEntry()]);
  }, [commit, entries]);

  const aliasCount = useMemo(
    () => entries.reduce((total, entry) => total + entry.aliases.length, 0),
    [entries],
  );

  const runImport = useCallback(() => {
    const parsed = parseBibleText(draft);
    if (parsed.entries.length === 0) {
      setImportMessage("No entries found. Use one name per line, for example: Kainel: male, Hero");
      return;
    }
    commit(parsed.entries.slice(0, MAX_BIBLE_ENTRIES));
    setImportMessage(`Loaded ${parsed.entries.length} entries from the pasted dictionary.`);
    setDraft("");
    setImporting(false);
  }, [commit, draft]);

  return (
    <div className="card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 p-4 text-left"
      >
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-ink-100">Story bible</span>
          <span className="mt-0.5 block text-xs text-ink-500">
            {entries.length} {entries.length === 1 ? "entry" : "entries"}
            {aliasCount > 0 ? ` · ${aliasCount} aliases` : ""} · saved in this browser
          </span>
        </span>
        <span
          aria-hidden
          className={`shrink-0 text-ink-500 transition-transform duration-200 ${open ? "rotate-45" : ""}`}
        >
          +
        </span>
      </button>

      {open ? (
        <div className="space-y-3 border-t border-ink-700 p-4">
          <p className="text-xs leading-relaxed text-ink-400">
            Every alias, title, and gender listed here travels with the chapter. A machine-translation
            variant that matches an alias is rewritten to the canonical name before the model reads the
            text, so &ldquo;Fine&rdquo; resolves to Phine instead of becoming a new character.
          </p>

          <ul className="space-y-3">
            {entries.map((entry) => (
              <li key={entry.id} className="rounded-lg border border-ink-700 bg-ink-900/40 p-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                  <div className="flex-1 space-y-2">
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto]">
                      <label className="block">
                        <span className="sr-only">Name</span>
                        <input
                          value={entry.name}
                          onChange={(event) => update(entry.id, { name: event.target.value })}
                          placeholder="Name"
                          className="w-full rounded-md border border-ink-700 bg-ink-950/60 px-2.5 py-1.5 text-sm text-ink-100 placeholder:text-ink-500 focus:border-accent-500 focus:outline-none"
                        />
                      </label>

                      <label className="block">
                        <span className="sr-only">Kind</span>
                        <select
                          value={entry.kind}
                          onChange={(event) =>
                            update(entry.id, { kind: event.target.value as BibleEntryKind })
                          }
                          className="rounded-md border border-ink-700 bg-ink-950/60 px-2.5 py-1.5 text-sm text-ink-100 focus:border-accent-500 focus:outline-none"
                        >
                          {BIBLE_ENTRY_KINDS.map((kind) => (
                            <option key={kind} value={kind}>
                              {BIBLE_KIND_LABELS[kind]}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="block">
                        <span className="sr-only">Gender</span>
                        <select
                          value={entry.gender ?? ""}
                          onChange={(event) => {
                            const value = event.target.value;
                            update(entry.id, { gender: value ? (value as Gender) : undefined });
                          }}
                          className="rounded-md border border-ink-700 bg-ink-950/60 px-2.5 py-1.5 text-sm text-ink-100 focus:border-accent-500 focus:outline-none"
                        >
                          {GENDER_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>

                    <label className="block">
                      <span className="block text-[11px] uppercase tracking-wider text-ink-500">
                        Aliases, comma separated
                      </span>
                      <input
                        value={entry.aliases.join(", ")}
                        onChange={(event) =>
                          update(entry.id, {
                            aliases: event.target.value
                              .split(",")
                              .map((alias) => alias.trim())
                              .filter(Boolean),
                          })
                        }
                        placeholder="Phine Grancia, Mardol"
                        className="mt-1 w-full rounded-md border border-ink-700 bg-ink-950/60 px-2.5 py-1.5 text-sm text-ink-100 placeholder:text-ink-500 focus:border-accent-500 focus:outline-none"
                      />
                    </label>

                    <label className="block">
                      <span className="block text-[11px] uppercase tracking-wider text-ink-500">
                        Role or relationship
                      </span>
                      <input
                        value={entry.role ?? ""}
                        onChange={(event) => update(entry.id, { role: event.target.value })}
                        placeholder="Glass Knight; Nameless Saintess on the alternate routes"
                        className="mt-1 w-full rounded-md border border-ink-700 bg-ink-950/60 px-2.5 py-1.5 text-sm text-ink-100 placeholder:text-ink-500 focus:border-accent-500 focus:outline-none"
                      />
                    </label>
                  </div>

                  <button
                    type="button"
                    onClick={() => remove(entry.id)}
                    className="btn-ghost shrink-0 !px-2.5 !py-1.5 text-xs text-warn-400"
                    aria-label={`Remove ${entry.name || "this entry"}`}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>

          {entries.length === 0 ? (
            <p className="rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2 text-sm text-ink-400">
              The dictionary is empty. Entries you add here are sent with every check.
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={add} className="btn-ghost !px-3 !py-1.5 text-xs">
              Add entry
            </button>
            <button
              type="button"
              onClick={() => setImporting((value) => !value)}
              className="btn-ghost !px-3 !py-1.5 text-xs"
            >
              {importing ? "Cancel paste" : "Paste a dictionary"}
            </button>
            <button
              type="button"
              onClick={() => {
                commit(defaultBible().entries);
                setImportMessage(null);
              }}
              className="btn-ghost !px-3 !py-1.5 text-xs"
            >
              Reset to the sample cast
            </button>
          </div>

          {importing ? (
            <div className="space-y-2">
              <label htmlFor="bible-import" className="block text-xs text-ink-400">
                One entry per line. A heading line such as CHARACTERS or LOCATIONS sets the kind for
                the lines beneath it.
              </label>
              <textarea
                id="bible-import"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                rows={8}
                spellCheck={false}
                placeholder={"CHARACTERS:\nPhine: female = Phine Grancia = Mardol; Glass Knight\nKainel: male; Hero"}
                className="prose-editor w-full resize-y rounded-md border border-ink-700 bg-ink-950/60 p-3 font-mono text-[13px] leading-relaxed text-ink-100 placeholder:text-ink-500 focus:border-accent-500 focus:outline-none"
              />
              <button
                type="button"
                onClick={runImport}
                className="btn-ghost !px-3 !py-1.5 text-xs"
              >
                Load these entries
              </button>
            </div>
          ) : null}

          {importMessage ? (
            <p className="rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2 text-xs text-ink-400">
              {importMessage}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
