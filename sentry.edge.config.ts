/**
 * Sentry edge runtime configuration — scaffolded but intentionally inert.
 */

import * as Sentry from "@sentry/nextjs";

const dsn = process.env.SENTRY_DSN;

Sentry.init({
  dsn,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 0,
  sampleRate: process.env.NODE_ENV === "production" ? 0.2 : 1,
  enabled: Boolean(dsn),
});
