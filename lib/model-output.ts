/**
 * Validation for model output.
 *
 * Kept free of `server-only` so the test harness and any future non-server
 * caller can reach it. The transport lives in llm.ts; this is just the parser.
 *
 * There are two readers, one per pass: the analyst's list of findings and the
 * rewriter's chapter.
 */

import type { AnalysisNote, ContinuityNote, IssueCategory } from "./types";
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

function parseJson(content: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(stripCodeFences(content));
  } catch {
    throw new LlmError("Provider response was not valid JSON");
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new LlmError("Provider response was not a JSON object");
  }

  return raw as Record<string, unknown>;
}

function readCategory(value: unknown): IssueCategory {
  return typeof value === "string" && (ISSUE_CATEGORIES as string[]).includes(value)
    ? (value as IssueCategory)
    : "grammar";
}

/**
 * Reads one finding from the analyst pass.
 *
 * A note with no excerpt cannot be tied to a place in the passage, and one with
 * no paragraph index cannot be tied to a paragraph, so both are required. The
 * paragraph index is clamped rather than dropped: a model that reports index
 * 400 for a three-paragraph chapter meant the last one.
 */
function normaliseNote(entry: unknown, paragraphCount: number): AnalysisNote | null {
  if (!entry || typeof entry !== "object") return null;

  const record = entry as Record<string, unknown>;
  const excerpt = typeof record.excerpt === "string" ? record.excerpt.trim() : "";
  if (!excerpt) return null;

  const rawParagraph = typeof record.paragraph === "number" ? Math.trunc(record.paragraph) : 0;
  const paragraph = Math.max(0, Math.min(paragraphCount - 1, rawParagraph));

  const title =
    typeof record.title === "string" && record.title.trim()
      ? record.title.trim()
      : "Needs rewriting";

  const intended =
    typeof record.intended === "string" && record.intended.trim()
      ? record.intended.trim()
      : "The literal wording does not carry the meaning the scene supports.";

  const rewrite = typeof record.rewrite === "string" ? record.rewrite.trim() : "";

  return {
    paragraph,
    category: readCategory(record.category),
    title,
    excerpt,
    intended,
    rewrite,
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
 * Reads the analyst's output.
 *
 * `paragraphCount` is the number of paragraphs in the passage that was sent, so
 * an index the model invented can be pulled back to the last paragraph instead
 * of being dropped. A malformed note is skipped rather than failing the pass,
 * because a partial list of findings still produces a usable rewrite. The
 * rewrite pass is the one that has to succeed; this one only has to help.
 */
export function parseAnalysis(
  content: string,
  paragraphCount: number,
): {
  notes: AnalysisNote[];
  continuity: ContinuityNote[];
} {
  const record = parseJson(content);

  const rawNotes = Array.isArray(record.notes) ? record.notes : [];
  const rawContinuity = Array.isArray(record.continuity) ? record.continuity : [];
  const limit = Math.max(1, Math.trunc(paragraphCount));

  return {
    notes: rawNotes
      .map((entry) => normaliseNote(entry, limit))
      .filter((note): note is AnalysisNote => note !== null)
      .slice(0, 60),
    continuity: rawContinuity
      .map((entry) => normaliseContinuity(entry))
      .filter((entry): entry is ContinuityNote => entry !== null),
  };
}

/**
 * Reads the rewriter's output.
 *
 * Unlike the analysis, a missing chapter throws: there is nothing to fall back
 * to inside a single pass, and the caller decides whether the whole request
 * falls back to the local engine.
 */
export function parseRewrite(content: string): { corrected: string } {
  const record = parseJson(content);
  const corrected = typeof record.corrected === "string" ? record.corrected.trim() : "";

  if (!corrected) {
    throw new LlmError("Provider response omitted the corrected chapter");
  }

  return { corrected };
}
