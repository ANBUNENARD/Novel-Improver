import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="border-t border-ink-800 bg-ink-950">
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-sm">
            <div className="flex items-center gap-2.5 font-semibold">
              <span
                aria-hidden
                className="grid h-7 w-7 place-items-center rounded-lg bg-accent-500 font-serif text-base font-bold text-ink-950"
              >
                P
              </span>
              <span>ProseLens</span>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-ink-400">
              A reading-first proofreading pass. Your draft stays in your browser — nothing is
              stored or sold.
            </p>
          </div>

          <nav aria-label="Footer" className="grid grid-cols-2 gap-x-12 gap-y-2 text-sm sm:grid-cols-1">
            <Link href="/#editor" className="text-ink-300 transition-colors hover:text-ink-50">
              Editor
            </Link>
            <Link href="/#how" className="text-ink-300 transition-colors hover:text-ink-50">
              How it works
            </Link>
            <Link href="/#faq" className="text-ink-300 transition-colors hover:text-ink-50">
              FAQ
            </Link>
          </nav>
        </div>

        <p className="mt-10 border-t border-ink-800 pt-6 text-xs text-ink-500">
          © {new Date().getFullYear()} ProseLens. Draft responsibly.
        </p>
      </div>
    </footer>
  );
}
