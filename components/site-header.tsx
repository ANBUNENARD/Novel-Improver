"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const NAV = [
  { href: "/#editor", label: "Editor" },
  { href: "/#how", label: "How it works" },
  { href: "/#faq", label: "FAQ" },
];

export function SiteHeader() {  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`sticky top-0 z-50 border-b transition-colors duration-300 ${
        scrolled
          ? "border-ink-700 bg-ink-950/85 backdrop-blur-md"
          : "border-transparent bg-transparent"
      }`}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5 font-semibold tracking-tight">
          <span
            aria-hidden
            className="grid h-8 w-8 place-items-center rounded-lg bg-accent-500 font-serif text-lg font-bold text-ink-950"
          >
            P
          </span>
          <span className="text-ink-50">ProseLens</span>
        </Link>

        <nav className="hidden items-center gap-1 sm:flex">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-lg px-3 py-2 text-sm text-ink-300 transition-colors hover:text-ink-50"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <Link href="/#editor" className="btn-primary !px-4 !py-2 text-sm">
          Paste a draft
        </Link>
      </div>
    </header>
  );
}
