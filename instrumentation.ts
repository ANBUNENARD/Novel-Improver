/**
 * Registers Sentry on the server when a DSN is configured.
 *
 * `register()` runs once per server process. The dynamic import is conditional
 * on a runtime check rather than `NEXT_PUBLIC_`, because on the server the
 * correct variable is `SENTRY_DSN`.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.SENTRY_DSN) {
    await import("./sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge" && process.env.SENTRY_DSN) {
    await import("./sentry.edge.config");
  }
}
