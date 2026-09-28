"use client";

import { useCallback, useState } from "react";

type State = "idle" | "sending" | "sent" | "error";

/**
 * Newsletter capture. Posts to /api/submit, which relays to
 * WEBHOOK_URL_NEWSLETTER when that variable is set.
 */
export function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<State>("idle");
  const [message, setMessage] = useState("");
  // Honeypot field: hidden from people, tempting to bots.
  const [trap, setTrap] = useState("");

  const submit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!email.trim()) return;

      setState("sending");
      setMessage("");

      try {
        const response = await fetch("/api/submit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ form: "newsletter", email: email.trim(), website: trap }),
        });

        const payload = (await response.json()) as { error?: string };

        if (!response.ok) {
          throw new Error(payload.error || "That did not go through.");
        }

        setState("sent");
        setEmail("");
      } catch (error) {
        setState("error");
        setMessage(error instanceof Error ? error.message : "Something went wrong.");
      }
    },
    [email, trap],
  );

  if (state === "sent") {
    return (
      <p className="rounded-xl border border-good-500/40 bg-good-500/10 px-5 py-4 text-sm text-good-400">
        You are on the list. I will be in touch.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="mx-auto w-full max-w-md">
      <div className="flex flex-col gap-3 sm:flex-row">
        <label htmlFor="waitlist-email" className="sr-only">
          Email address
        </label>
        <input
          id="waitlist-email"
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          className="flex-1 rounded-xl border border-ink-600 bg-ink-900/60 px-4 py-3 text-sm text-ink-100 placeholder:text-ink-500 focus:border-accent-500 focus:outline-none"
        />
        <button type="submit" disabled={state === "sending"} className="btn-primary">
          {state === "sending" ? "Joining…" : "Join the list"}
        </button>
      </div>

      <div aria-hidden className="absolute h-0 w-0 overflow-hidden">
        <label htmlFor="waitlist-website">Website</label>
        <input
          id="waitlist-website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={trap}
          onChange={(event) => setTrap(event.target.value)}
        />
      </div>

      {state === "error" ? (
        <p role="alert" className="mt-3 text-sm text-warn-400">
          {message}
        </p>
      ) : null}
    </form>
  );
}
