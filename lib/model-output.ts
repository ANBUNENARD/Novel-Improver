/**
 * Validation for model output.
 *
 * Kept free of `server-only` so the test harness and any future non-server
 * caller can reach it. The transport lives in llm.ts; this is just the parser.
 */

import type { ContinuityNote, IssueCategory, Suggestion } from "./types";
import { ISSUE_CATEGORIES } from "./types";

/** Strips markdown fences some providers wrap JSON in. */
function stripCodeFences(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith("```")) return trimmed;

  return trimmed
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```$/, "")
    .trim();
}

/** Raised when a provider's response cannot be used. */
export class LlmError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "LlmError";
    this.status = status;
  }
}

function normaliseSuggestion(entry: unknown, index: number): Suggestion | null {
  if (!entry || typeof entry !== "object") return null;

  const record = entry as Record<string, unknown>;
  const original = typeof record.original === "string" ? record.original : "";
  const suggestion = typeof record.suggestion === "string" ? record.suggestion : "";

  // An entry with no source text cannot be applied to the passage.
  if (!original || !suggestion) return null;

  const rawCategory = typeof record.category === "string" ? record.category : "grammar";
  const category = (ISSUE_CATEGORIES as string[]).includes(rawCategory)
    ? (rawCategory as IssueCategory)
    : "grammar";

  const title =
    typeof record.title === "string" && record.title.trim()
      ? record.title.trim()
      : "Suggested revision";

  const note = typeof record.note === "string" && record.note.trim() ? record.note.trim() : undefined;

  return {
    id: `s${index + 1}`,
    category,
    title,
    original,
    suggestion,
    ...(note ? { note } : {}),
  };
}

function normaliseContinuity(entry: unknown): ContinuityNote | null {
  if (!entry || typeof entry !== "object") return null;

  const record = entry as Record<string, unknown>;
  const raw = typeof record.raw === "string" ? record.raw.trim() : "";
  const canonical = typeof record.canonical === "string" ? record.canonical.trim() : "";

  // A note that does not name both ends cannot explain a rename to the reader.
  if (!raw || !canonical) return null;

  const via = typeof record.via === "string" && record.via.trim() ? record.via.trim() : undefined;
  const context = typeof record.context === "string" && record.context.trim() ? record.context.trim() : undefined;
  const note = typeof record.note === "string" && record.note.trim() ? record.note.trim() : undefined;

  return {
    raw,
    canonical,
    ...(via ? { via } : {}),
    ...(context ? { context } : {}),
    ...(note ? { note } : {}),
  };
}

/**
 * Parses and validates the provider's JSON payload.
 *
 * Throws `LlmError` when the response is unusable so the caller can fall back
 * to the local engine rather than rendering a half-built result.
 */
export function parseModelOutput(content: string): {
  corrected: string;
  suggestions: Suggestion[];
  continuity: ContinuityNote[];
} {
  let raw: unknown;
  try {
    raw = JSON.parse(stripCodeFences(content));
  } catch {
    throw new LlmError("Provider response was not valid JSON");
  }

  if (!raw || typeof raw !== "object") {
    throw new LlmError("Provider response was not a JSON object");
  }

  const record = raw as { corrected?: unknown; suggestions?: unknown; continuity?: unknown };
  const corrected = typeof record.corrected === "string" ? record.corrected.trim() : "";

  if (!corrected) {
    throw new LlmError("Provider response omitted the corrected passage");
  }

  const suggestions = Array.isArray(record.suggestions) ? record.suggestions : [];
  const continuity = Array.isArray(record.continuity) ? record.continuity : [];

  return {
    corrected,
    suggestions: suggestions
      .map((entry, index) => normaliseSuggestion(entry, index))
      .filter((entry): entry is Suggestion => entry !== null),
    continuity: continuity
      .map((entry) => normaliseContinuity(entry))
      .filter((entry): entry is ContinuityNote => entry !== null),
  };
}
