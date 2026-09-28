import { NextResponse } from "next/server";

import { correct, validateRequest } from "@/lib/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const validated = validateRequest(body);

  if ("error" in validated) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }

  try {
    const result = await correct(
      validated.text,
      validated.tone,
      validated.categories,
      validated.povMode,
      validated.storyBible,
      validated.model,
      validated.apiKey,
    );
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    // `correct` handles provider failures internally, so reaching here means a
    // genuine bug. Log it and return a generic message rather than internals.
    console.error("[api/correct] unhandled failure", error);
    return NextResponse.json(
      { error: "The check could not be completed. Try again in a moment." },
      { status: 500 },
    );
  }
}
