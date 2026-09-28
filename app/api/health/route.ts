import { NextResponse } from "next/server";
import { readLlmConfig, readTransport } from "@/lib/llm";
import { MODEL_CHOICES } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Liveness and readiness probe.
 *
 * Reports whether the LLM is wired up so a deploy can be checked without
 * opening the app. Never exposes the key itself, only whether one is present.
 */
export function GET() {
  const config = readLlmConfig();
  // The endpoint and transport are settings rather than credentials, so they
  // are reported even with no key. A deploy that wired the wrong base url has to
  // be visible in a health check, and a keyless instance still has one.
  const transport = config ?? readTransport();
  const provider = transport.provider;

  // Only the models the configured provider can actually serve, so the picker
  // never offers one the key cannot reach. The list is served even with no
  // server key, because the reader can paste one into the page.
  const models = MODEL_CHOICES.filter((choice) =>
    provider === "gemini" ? choice.id.startsWith("gemini-") : choice.id.startsWith("gpt-"),
  );

  // `LLM_MODEL` is free text, so it can name a model the picker does not list.
  // `defaultModel` is the one a pass runs when the reader has chosen nothing,
  // which keeps the picker showing the truth about what will actually run.
  // With no server model that is the first entry, which is the cheapest model
  // and therefore the one a reader who just pasted a key gets by default.
  const configuredModel = config?.model ?? null;
  const listed = models.some((choice) => choice.id === configuredModel);

  return NextResponse.json(
    {
      status: "ok",
      service: "proselens",
      timestamp: new Date().toISOString(),
      llm: {
        configured: config !== null,
        model: configuredModel,
        defaultModel: listed ? configuredModel : (models[0]?.id ?? null),
        provider,
        baseUrl: transport.baseUrl,
        models: models.map(({ id, label, note }) => ({ id, label, note })),
      },
    },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
