import { NextResponse } from "next/server";

/**
 * Generic form relay.
 *
 * The client posts `{ form, ...fields }` and this route forwards the payload to
 * the webhook configured for that form name. Forms and their env vars:
 *
 *   contact    -> WEBHOOK_URL_CONTACT
 *   newsletter -> WEBHOOK_URL_NEWSLETTER
 *   waitlist   -> WEBHOOK_URL_WAITLIST
 *   schedule   -> WEBHOOK_URL_SCHEDULE
 *
 * With no webhook configured the request is accepted and logged, so local and
 * preview deployments work before any credentials exist.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KNOWN_FORMS = ["contact", "newsletter", "waitlist", "schedule"] as const;

type FormName = (typeof KNOWN_FORMS)[number];

function webhookFor(form: string): string | null {
  const envVar = `WEBHOOK_URL_${form.toUpperCase()}`;
  return process.env[envVar]?.trim() || null;
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;

  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const form = typeof body.form === "string" ? body.form : "";

  if (!(KNOWN_FORMS as readonly string[]).includes(form)) {
    return NextResponse.json(
      { error: `Unknown form "${form}". Expected one of: ${KNOWN_FORMS.join(", ")}.` },
      { status: 400 },
    );
  }

  const fields: Record<string, unknown> = { ...body };
  delete fields.form;

  // Honeypot: a real person never fills a field they cannot see.
  if (typeof fields.website === "string" && fields.website.trim()) {
    return NextResponse.json({ ok: true, delivered: false }, { status: 200 });
  }

  if (form === "contact") {
    const email = typeof fields.email === "string" ? fields.email.trim() : "";
    const message = typeof fields.message === "string" ? fields.message.trim() : "";

    if (!message) {
      return NextResponse.json({ error: "Please include a message." }, { status: 400 });
    }

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: "That email address does not look right." }, { status: 400 });
    }
  }

  const url = webhookFor(form as FormName);

  if (!url) {
    console.info(`[api/submit] no webhook configured for "${form}"; accepted without delivery`);
    return NextResponse.json({ ok: true, delivered: false }, { status: 200 });
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ form, source: "proselens", receivedAt: new Date().toISOString(), fields }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      console.error(`[api/submit] webhook for "${form}" returned ${response.status}`);
      return NextResponse.json(
        { error: "The form provider did not accept this submission. Try again shortly." },
        { status: 502 },
      );
    }

    return NextResponse.json({ ok: true, delivered: true }, { status: 200 });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[api/submit] webhook for "${form}" unreachable: ${reason}`);
    return NextResponse.json(
      { error: "The form provider is unreachable. Try again shortly." },
      { status: 502 },
    );
  }
}
