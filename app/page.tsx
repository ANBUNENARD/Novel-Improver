import { Editor } from "@/components/editor/editor";

export default function HomePage() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
      <h1 className="text-balance text-3xl font-bold tracking-tight text-ink-50 sm:text-4xl">
        Improve a chapter
      </h1>
      <p className="mt-3 max-w-2xl text-pretty leading-relaxed text-ink-400">
        Paste your key, choose a model, then paste a chapter. Each rewritten paragraph appears
        beside the one it came from, and you keep or undo it before you copy.
      </p>

      <div className="mt-8">
        <Editor />
      </div>
    </section>
  );
}
