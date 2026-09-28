/**
 * Sentry configuration — scaffolded but intentionally inert.
 *
 * No DSN is committed, so with no `NEXT_PUBLIC_SENTRY_DSN` set the SDK
 * initialises and immediately becomes a no-op: zero network calls, no
 * overhead. To go live, set NEXT_PUBLIC_SENTRY_DSN (plus SENTRY_DSN for the
 * server) and nothing in this file needs to change.
 */

import * as Sentry from "@sentry/nextjs";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  environment: process.env.NODE_ENV,

  tracesSampleRate: 0,
  sampleRate: process.env.NODE_ENV === "production" ? 0.2 : 1,

  // Off until a DSN exists. This is what keeps the scaffold inert.
  enabled: Boolean(dsn),

  // Never ship these — manuscripts are the user's content.
  beforeSend(event) {
    if (event.request) {
      delete event.request.cookies;
      delete event.request.data;
      delete event.request.query_string;
    }
    return event;
  },
});
