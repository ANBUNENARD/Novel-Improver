import Link from "next/link";

import { Editor } from "@/components/editor/editor";
import { Reveal } from "@/components/reveal";
import { WaitlistForm } from "@/components/waitlist-form";

const STEPS = [
  {
    title: "Add your key",
    body: "Paste your OpenAI key into the field at the top of the editor. It stays in this browser, so you never have to edit a file to use the app.",
  },
  {
    title: "Choose a model",
    body: "Pick the model that writes the rewrite. A fast one costs a few cents a chapter; a stronger one costs more and rewrites more sharply.",
  },
  {
    title: "Paste the chapter",
    body: "Drop in a chapter, a scene, or one paragraph that will not sit right. Up to 60,000 characters at a time, and your pasted text is never overwritten.",
  },
];

const FAQS = [
  {
    q: "Where do I put my API key?",
    a: "In the field labelled OpenAI key, at the top of the editor. It is kept in this browser's local storage and posted with each run. It is never written to a file, a database, or a server log, and Show reveals it when you need to check what is in the box.",
  },
  {
    q: "Which model should I choose?",
    a: "GPT-4o mini is the sensible default: fast, cheap, and good enough for most machine-translated prose. GPT-4.1 handles long chapters best value. GPT-4o and GPT-4.1 rewrite more sharply and cost more. The picker only ever offers models your key can actually reach.",
  },
  {
    q: "Is my manuscript uploaded anywhere?",
    a: "The chapter is sent to the model provider for a single pass, then discarded. Nothing is written to a database, logged as content, or used to train anything. Your key goes straight from the browser to the provider.",
  },
  {
    q: "What happens without a key?",
    a: "The built-in rules engine takes over. It handles contractions, duplicated words, spacing, and sentence length, and it runs entirely locally, which is useful for trying the editor before adding a key.",
  },
  {
    q: "How long can a single paste be?",
    a: "Up to 60,000 characters. For a long novel, run it chapter by chapter. The analysis is per-passage, so a chapter at a time gives you a far more useful read than one enormous block.",
  },
];

export default function HomePage() {
  return (
    <>
      <section className="relative overflow-hidden border-b border-ink-800">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{
            background:
              "radial-gradient(60rem 30rem at 50% -10%, color-mix(in oklch, var(--color-accent-500) 22%, transparent), transparent 70%)",
          }}
        />

        <div className="relative mx-auto max-w-4xl px-4 pb-16 pt-20 text-center sm:px-6 sm:pb-20 sm:pt-28">
          <Reveal>
            <span className="inline-flex items-center gap-2 rounded-full border border-ink-700 bg-ink-900/60 px-3.5 py-1.5 text-xs text-ink-300">
              <span className="h-1.5 w-1.5 rounded-full bg-accent-400" />
              Reads like an editor, not a spellchecker
            </span>
          </Reveal>

          <Reveal delay={0.08}>
            <h1 className="mt-6 text-balance text-4xl font-bold leading-[1.08] tracking-tight text-ink-50 sm:text-6xl">
              Find the sentence you already{" "}
              <span className="font-serif italic text-accent-400">knew</span> was wrong
            </h1>
          </Reveal>

          <Reveal delay={0.16}>
            <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-ink-300">
              Add your OpenAI key, pick a model, paste a chapter. ProseLens rebuilds the
              machine-translated prose as natural English and hands the rewrite back to you.
            </p>
          </Reveal>

          <Reveal delay={0.24}>
            <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link href="/#editor" className="btn-primary w-full sm:w-auto sm:min-w-48">
                Paste a chapter
              </Link>
              <Link href="/#how" className="btn-ghost w-full sm:w-auto">
                See how it works
              </Link>
            </div>
          </Reveal>
        </div>
      </section>

      <section id="editor" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-16 sm:px-6 sm:py-20">
        <Reveal>
          <h2 className="text-2xl font-semibold tracking-tight text-ink-50 sm:text-3xl">
            The editor
          </h2>
          <p className="mt-2 max-w-2xl text-ink-400">
            Paste your key at the top, choose a model, then drop in a chapter. The improved
            version comes back on the right. Works the same on a phone as on a desktop.
          </p>
        </Reveal>

        <Reveal delay={0.1} className="mt-8">
          <Editor />
        </Reveal>
      </section>

      <section id="how" className="scroll-mt-20 border-y border-ink-800 bg-ink-900/30">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <Reveal>
            <h2 className="text-2xl font-semibold tracking-tight text-ink-50 sm:text-3xl">
              Three steps, no account
            </h2>
          </Reveal>

          <div className="mt-10 grid grid-cols-1 gap-5 sm:grid-cols-3">
            {STEPS.map((step, index) => (
              <Reveal key={step.title} delay={0.08 * (index + 1)}>
                <div className="card h-full p-6">
                  <span className="font-serif text-3xl font-bold text-accent-500/70">
                    {index + 1}
                  </span>
                  <h3 className="mt-3 text-lg font-semibold text-ink-50">{step.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-ink-300">{step.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section id="faq" className="mx-auto max-w-3xl scroll-mt-20 px-4 py-16 sm:px-6 sm:py-20">
        <Reveal>
          <h2 className="text-2xl font-semibold tracking-tight text-ink-50 sm:text-3xl">
            Questions
          </h2>
        </Reveal>

        <div className="mt-8 space-y-3">
          {FAQS.map((faq, index) => (
            <Reveal key={faq.q} delay={0.05 * (index + 1)}>
              <details className="card group p-5">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-left font-medium text-ink-50 marker:hidden">
                  {faq.q}
                  <span
                    aria-hidden
                    className="shrink-0 text-ink-500 transition-transform duration-200 group-open:rotate-45"
                  >
                    +
                  </span>
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-ink-300">{faq.a}</p>
              </details>
            </Reveal>
          ))}
        </div>
      </section>

      <section className="border-t border-ink-800 bg-ink-900/30">
        <div className="mx-auto max-w-2xl px-4 py-16 text-center sm:px-6 sm:py-20">
          <Reveal>
            <h2 className="text-2xl font-semibold tracking-tight text-ink-50 sm:text-3xl">
              Working on something long?
            </h2>
            <p className="mx-auto mt-3 max-w-lg text-ink-400">
              Get a note when ProseLens adds automatic chapter batching and side-by-side diff
              export.
            </p>
          </Reveal>

          <Reveal delay={0.1} className="mt-8">
            <WaitlistForm />
          </Reveal>
        </div>
      </section>
    </>
  );
}
