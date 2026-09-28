"use client";

/**
 * API key field.
 *
 * The key is held in this browser's local storage and sent with each run. It is
 * never written to a file or to a server log, and the input is masked so it does
 * not sit on screen in the clear.
 */

import { useEffect, useState } from "react";

const STORAGE_KEY = "proselens:apiKey";

interface KeyFieldProps {
  value: string;
  onChange: (apiKey: string) => void;
}

/** Reads the saved key. Called once, before the first paint that matters. */
export function readSavedKey(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    // Private browsing modes can refuse local storage. The key then lives only
    // as long as the tab does, which still works.
    return "";
  }
}

export function saveKey(apiKey: string) {
  try {
    if (apiKey) window.localStorage.setItem(STORAGE_KEY, apiKey);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // A full or unavailable store must not break the run.
  }
}

export function KeyField({ value, onChange }: KeyFieldProps) {
  const [revealed, setRevealed] = useState(false);

  // The saved key is only in local storage on this machine, so it is read after
  // mount rather than during render, which would differ between server and client.
  useEffect(() => {
    const saved = readSavedKey();
    if (saved && saved !== value) onChange(saved);
    // Runs once, to pick up a key saved in an earlier visit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <label htmlFor="api-key" className="text-[11px] uppercase tracking-wider text-ink-500">
          API key
        </label>
        <span className="text-[11px] text-ink-500">saved in this browser only</span>
      </div>

      <div className="flex items-center gap-2">
        <input
          id="api-key"
          type={revealed ? "text" : "password"}
          value={value}
          spellCheck={false}
          autoComplete="off"
          placeholder="sk-proj-..."
          onChange={(event) => {
            onChange(event.target.value);
            saveKey(event.target.value);
          }}
          className="input flex-1"
        />
        <button
          type="button"
          onClick={() => setRevealed((shown) => !shown)}
          className="chip"
          aria-pressed={revealed}
        >
          {revealed ? "Hide" : "Show"}
        </button>
        {value ? (
          <button
            type="button"
            onClick={() => {
              onChange("");
              saveKey("");
            }}
            className="chip"
          >
            Clear
          </button>
        ) : null}
      </div>
    </div>
  );
}
