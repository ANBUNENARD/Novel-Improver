import "server-only";

/**
 * Reader-supplied provider credentials.
 *
 * The key is typed into the page and kept in that browser's local storage, then
 * posted with each run. It is used for that one request and never written to
 * disk or logged. A server environment key still wins when one is set, so a
 * hosted deployment keeps working with no key in the browser.
 */

import { readTransport } from "./llm";
import type { LlmConfig } from "./llm";
import { normaliseApiKey } from "./validate";

/** Builds a config for a key the reader pasted in. */
export function configFromRequest(
  apiKey: string,
  model: string | null,
): LlmConfig | null {
  const key = normaliseApiKey(apiKey);
  if (!key) return null;

  // A pasted key is an OpenAI key by default. The provider and endpoint are
  // server-side settings, so a reader cannot point the app at their own server.
  // They are read without a key of their own, because this is the path taken
  // precisely when the server has none: gating them on a key is what would send
  // a pasted key to api.openai.com while `LLM_BASE_URL` pointed somewhere else.
  const server = readTransport();

  // With a key pasted in and nothing chosen, the cheapest model runs. A reader
  // trying the app for the first time should not be charged for a sharper one.
  // A server that names its own model keeps it, so a hosted deployment still
  // decides what its visitors run.
  const fallbackModel = server.provider === "gemini" ? "gemini-2.5-flash" : "gpt-5-nano";

  return {
    baseUrl: server.baseUrl,
    apiKey: key,
    model: model ?? server.model ?? fallbackModel,
    timeoutMs: server.timeoutMs,
    provider: server.provider,
  };
}
