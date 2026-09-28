export function SiteHeader() {
  return (
    <header className="border-b border-ink-800">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-2.5 px-4 font-semibold tracking-tight sm:px-6">
        <span
          aria-hidden
          className="grid h-8 w-8 place-items-center rounded-lg bg-accent-500 font-serif text-lg font-bold text-ink-950"
        >
          P
        </span>
        <span className="text-ink-50">ProseLens</span>
      </div>
    </header>
  );
}
