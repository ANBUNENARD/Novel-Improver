"use client";

import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";
import { useRef } from "react";

gsap.registerPlugin(ScrollTrigger, useGSAP);

/**
 * Fades and lifts children into view once on scroll.
 *
 * Content is visible by default in CSS; this only animates elements that GSAP
 * has successfully claimed, so a failed or skipped animation leaves the page
 * readable rather than blank.
 */
export function Reveal({
  children,
  delay = 0,
  y = 24,
  className,
}: {
  children: React.ReactNode;
  delay?: number;
  y?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const element = ref.current;
      if (!element) return;

      // Respect the OS setting instead of animating regardless.
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

      gsap.from(element, {
        opacity: 0,
        y,
        duration: 0.7,
        delay,
        ease: "power2.out",
        scrollTrigger: {
          trigger: element,
          start: "top 88%",
          once: true,
        },
      });
    },
    { scope: ref, dependencies: [delay, y] },
  );

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
