"use client";

/**
 * The editor: paste a chapter, pick a model, read the rewrite.
 *
 * The rest of the pipeline runs at fixed settings. Tone is Polished, point of
 * view is read for unclear speakers, every issue category is checked, and the
 * saved character dictionary travels with the chapter so names stay spelled one
 * way across it. Those used to have their own rows of controls; the page is
 * the key, the model, the paste box, and the output now.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { KeyField } from "./key-field";
import { ModelPicker } from "./model-picker";

import { readStoredBible } from "@/lib/default-bible";
import type { CorrectionResult, PovMode, StoryBible, TonePreset } from "@/lib/types";
import { ISSUE_CATEGORIES } from "@/lib/types";

type Status = "idle" | "loading" | "done" | "error";

/** How far the rewriting goes. Polished keeps the author's voice. */
const TONE: TonePreset = "polished";

/** Speakers are read and reported; nothing is rewritten on their account. */
const POV_MODE: PovMode = "detect";

const SAMPLE = `It were a quiet morning in the small town of Ashford, and the mist was rolling
in off the river like it had somewhere important to be.  Sarah was walking down the main
street with her dog, thinking about the letter she had recieved that morning.  She had
been thinking about it for days now and she could not shake the feeling that something was
wrong.  She had not told anyone about it, not even her mother, and she was not planning to.
The postman came around the corner, and he waved at her, and she waved back, but she
didnt really see him.  Her mind was elsewhere.  She was thinking about the letter, and what
it meant, and what she was going to do.  It was a very very long letter and it was going to
change everything.

"Morning," Minjun said. "You are early."
"I am fine," Minjun said.
"No, you're not," Minjun said.`;

export function Editor() {
  const [text, setText] = useState("");
  const [apiKey, setApiKey] = useState("");
  // Empty means "use whatever the server is configured with", which is also
  // what happens when the app has no key on either side.
  const [model, setModel] = useState("");
  const [bible, setBible] = useState<StoryBible>(() => readStoredBible());
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CorrectionResult | null>(null);
  const [copied, setCopied] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  const words = useMemo(() => text.trim().split(/\s+/).filter(Boolean).length, [text]);

  // The dictionary is read after mount, since local storage is only reachable
  // in the browser and the first render has to match on both sides.
  useEffect(() => {
    setBible(readStoredBible());
  }, []);

  const run = useCallback(async () => {
    if (!text.trim()) {
      setError("Paste some text before running the check.");
      setStatus("error");
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setStatus("loading");
    setError(null);

    try {
      const response = await fetch("/api/correct", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          tone: TONE,
          categories: ISSUE_CATEGORIES,
          povMode: POV_MODE,
          storyBible: bible,
          model,
          apiKey,
        }),
        signal: controller.signal,
      });

      const payload = (await response.json()) as CorrectionResult & { error?: string };

      if (!response.ok) {
        throw new Error(payload.error || "The check failed. Try again.");
      }

      setResult(payload);
      setStatus("done");
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError(caught instanceof Error ? caught.message : "Something went wrong.");
      setStatus("error");
    }
  }, [text, bible, model, apiKey]);

  // Scroll the result into view on mobile, where the output sits below the fold.
  useEffect(() => {
    if (status !== "done" && status !== "error") return;
    if (window.matchMedia("(max-width: 1023px)").matches) {
      outputRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [status]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const copyOutput = useCallback(async () => {
    if (!result?.corrected) return;
    try {
      await navigator.clipboard.writeText(result.corrected);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Clipboard access was blocked by the browser. Select the text and copy manually.");
      setStatus("error");
    }
  }, [result]);

  const downloadOutput = useCallback(() => {
    if (!result?.corrected) return;

    const blob = new Blob([result.corrected], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "proselens-improved.txt";
    anchor.click();
    URL.revokeObjectURL(url);
  }, [result]);

  return (
    <div className="space-y-6">
      <div className="card space-y-4 p-4 sm:p-5">
        <KeyField value={apiKey} onChange={setApiKey} />

        <div className="border-t border-ink-700 pt-4">
          <ModelPicker value={model} onChange={setModel} />
        </div>

        <p className="border-t border-ink-700 pt-3 text-xs leading-relaxed text-ink-500">
          Names, aliases, and roles from your saved character dictionary travel with the chapter
          automatically, so the same person is spelled one way throughout.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="card flex min-h-[26rem] flex-col p-4 sm:p-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-ink-100">Your chapter</h3>
            <button
              type="button"
              onClick={() => {
                setText(SAMPLE);
                setResult(null);
                setStatus("idle");
              }}
              className="text-xs text-ink-400 underline-offset-4 transition-colors hover:text-accent-400 hover:underline"
            >
              Load a sample
            </button>
          </div>

          <label htmlFor="draft" className="sr-only">
            Paste the chapter you want improved
          </label>
          <textarea
            id="draft"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={"Paste a chapter, a scene, or a single stubborn paragraph\u2026"}
            spellCheck
            className="prose-editor min-h-[20rem] flex-1 resize-y rounded-lg border border-ink-700 bg-ink-900/50 p-4 font-serif text-[15px] leading-relaxed text-ink-100 placeholder:text-ink-500 focus:border-accent-500 focus:outline-none"
          />

          <div className="mt-3 flex flex-col gap-2">
            <button
              type="button"
              onClick={run}
              disabled={status === "loading" || !text.trim()}
              className="btn-primary w-full"
            >
              {status === "loading" ? "Improving\u2026" : "Improve this chapter"}
            </button>
            <p className="text-center text-xs text-ink-500">
              {words.toLocaleString()} {words === 1 ? "word" : "words"} pasted
            </p>

          </div>
        </section>

        <section
          ref={outputRef}
          aria-live="polite"
          aria-busy={status === "loading"}
          className="card flex min-h-[26rem] flex-col p-4 sm:p-5"
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-ink-100">Improved chapter</h3>

            {result && status === "done" ? (
              <div className="flex items-center gap-2">
                <button type="button" onClick={copyOutput} className="btn-ghost !px-3 !py-1.5 text-xs">
                  {copied ? "Copied" : "Copy"}
                </button>
                <button
                  type="button"
                  onClick={downloadOutput}
                  className="btn-ghost !px-3 !py-1.5 text-xs"
                >
                  Download
                </button>
              </div>
            ) : null}
          </div>

          {status === "loading" ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16">
              <span
                aria-hidden
                className="h-6 w-6 animate-spin rounded-full border-2 border-ink-600 border-t-accent-400"
              />
              <p className="text-sm text-ink-400">{"Reading your chapter\u2026"}</p>
            </div>
          ) : null}

          {status === "error" ? (
            <div
              role="alert"
              className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center"
            >
              <p className="text-sm text-warn-400">{error}</p>
            </div>
          ) : null}

          {status === "idle" ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
              <p className="text-sm text-ink-400">Your improved chapter will appear here.</p>
              <p className="max-w-xs text-xs text-ink-500">
                The text you paste stays exactly as you wrote it. This is a separate, rephrased
                version to copy.
              </p>
            </div>
          ) : null}

          {status === "done" && result ? (
            <div className="flex-1 space-y-4">
              {result.fallbackReason ? (
                <p className="rounded-lg border border-warn-600/40 bg-warn-500/10 px-3 py-2 text-xs text-warn-400">
                  {result.fallbackReason}
                </p>
              ) : null}

              <div className="rounded-lg border border-ink-700 bg-ink-900/50 p-4">
                <p className="prose-editor whitespace-pre-wrap font-serif text-[15px] leading-relaxed text-ink-100">
                  {result.corrected}
                </p>
              </div>

              <p className="text-xs text-ink-500">
                Your pasted text is untouched. Copy or download this version once you are happy
                with it.
              </p>
            </div>
          ) : null}
        </section>
      </div>

      <p className="text-center text-xs text-ink-500">
        The chapter is sent to the model you picked for a single pass, then discarded. Your API
        key stays in this browser and is never written to a file or a server log.
      </p>
    </div>
  );
}
