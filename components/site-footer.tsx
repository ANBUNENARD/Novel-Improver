export function SiteFooter() {
  return (
    <footer className="border-t border-ink-800 bg-ink-950">
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        <p className="text-xs text-ink-500">
          © {new Date().getFullYear()} ProseLens. Your chapter is sent to the model you chose and
          discarded afterwards.
        </p>
      </div>
    </footer>
  );
}
