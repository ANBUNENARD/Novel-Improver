import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-[70vh] max-w-xl flex-col items-center justify-center px-4 text-center">
      <p className="font-serif text-6xl font-bold text-accent-500/70">404</p>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight text-ink-50">
        This page is not in the manuscript
      </h1>
      <p className="mt-3 text-ink-400">
        The link may be stale, or the page may have moved during a rewrite.
      </p>
      <Link href="/#editor" className="btn-primary mt-8">
        Back to the editor
      </Link>
    </div>
  );
}
