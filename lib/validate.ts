/**
 * Request validation for POST /api/correct.
 *
 * Pure and free of `server-only` so the test harness can exercise it directly.
 */

import { normaliseBible } from "./story-bible";
import type { IssueCategory, PovMode, StoryBible, TonePreset } from "./types";
import { ISSUE_CATEGORIES, POV_MODES, TONE_PRESETS } from "./types";

/** Upper bound on a single request. Novel chapters are large; this is generous. */
export const MAX_TEXT_LENGTH = 60_000;

export interface ValidRequest {
  text: string;
  tone: TonePreset;
  categories: IssueCategory[];
  povMode: PovMode;
  storyBible: StoryBible;
  model: string | null;
  /** A key pasted into the page, or null when the server is configured with one. */
  apiKey: string | null;
}

export type ValidationResult = ValidRequest | { error: string };

/**
 * Model ids the reader may pick from, cheapest first.
 *
 * The set is fixed rather than free text: a typo would otherwise be forwarded
 * to the provider as a 404, and an arbitrary string would let a caller use the
 * key against models the account cannot reach.
 *
 * OpenAI bills every one of these per token and has no ongoing free tier, so
 * the notes quote the real per-million-token price to help a reader pick.
 * `fixedTemperature` marks the reasoning models, which reject any temperature
 * other than the default and 400 without it.
 */
export const MODEL_CHOICES = [
  { id: "gpt-5-nano", label: "GPT-5 nano", note: "Cheapest here. $0.05 in / $0.40 out per 1M tokens. Try this one first.", fixedTemperature: true },
  { id: "gpt-4.1-nano", label: "GPT-4.1 nano", note: "$0.10 in / $0.40 out. Very cheap and 1M-token context.", fixedTemperature: false },
  { id: "gpt-4o-mini", label: "GPT-4o mini", note: "$0.15 in / $0.60 out. A safe all-rounder for prose.", fixedTemperature: false },
  { id: "gpt-5-mini", label: "GPT-5 mini", note: "$0.25 in / $2.00 out. Sharper than the nanos.", fixedTemperature: true },
  { id: "gpt-4.1-mini", label: "GPT-4.1 mini", note: "$0.40 in / $1.60 out. Good for long chapters.", fixedTemperature: false },
  { id: "gpt-4o", label: "GPT-4o", note: "$2.50 in / $10.00 out. Much costlier, noticeably sharper.", fixedTemperature: false },
  { id: "gpt-4.1", label: "GPT-4.1", note: "$2.00 in / $8.00 out. The costliest here.", fixedTemperature: false },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", note: "Genuinely free tier with a Gemini key.", fixedTemperature: false },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", note: "Free tier, slower and sharper.", fixedTemperature: false },
] as const;

/** Longest model id accepted, so an obvious junk value is rejected early. */
const MAX_MODEL_LENGTH = 64;

/**
 * Models that only accept the default temperature.
 *
 * Derived from `MODEL_CHOICES` so the list is declared once: a model added
 * there cannot be left out of the check that keeps it from being sent a
 * temperature it would reject.
 */
export const FIXED_TEMPERATURE_MODELS: ReadonlySet<string> = new Set(
  MODEL_CHOICES.filter((choice) => choice.fixedTemperature).map((choice) => choice.id),
);

/** Longest key accepted, so an obvious junk value is rejected early. */
const MAX_API_KEY_LENGTH = 200;

/**
 * Cleans a pasted key, or returns null when there is nothing usable.
 *
 * Keys are copied with stray whitespace and spaces about half the time, and a
 * leading or trailing character silently produces an auth failure, so this
 * strips them before anything else looks at the value.
 */
export function normaliseApiKey(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const key = input.trim().replace(/\s+/g, "");
  if (!key) return null;
  if (key.length > MAX_API_KEY_LENGTH) return null;
  return key;
}

export function validateRequest(body: unknown): ValidationResult {
  if (!body || typeof body !== "object") {
    return { error: "Request body must be a JSON object." };
  }

  const record = body as Record<string, unknown>;
  const text = typeof record.text === "string" ? record.text : "";

  if (!text.trim()) {
    return { error: "Paste some text before running the check." };
  }

  if (text.length > MAX_TEXT_LENGTH) {
    return {
      error: `Text is ${text.length.toLocaleString()} characters. The limit is ${MAX_TEXT_LENGTH.toLocaleString()} — split the chapter and run it in parts.`,
    };
  }

  const toneInput = typeof record.tone === "string" ? record.tone : "polished";
  const tone = (TONE_PRESETS as string[]).includes(toneInput)
    ? (toneInput as TonePreset)
    : "polished";

  const categoriesInput = Array.isArray(record.categories) ? record.categories : [];
  const categories = categoriesInput.filter(
    (value): value is IssueCategory => (ISSUE_CATEGORIES as string[]).includes(String(value)),
  );

  // POV analysis defaults to detect rather than off: a reader losing track of who
  // is speaking is the defect the tool exists to catch, and detection changes no
  // text, so it is safe to leave on.
  const povInput = typeof record.povMode === "string" ? record.povMode : "detect";
  const povMode = (POV_MODES as string[]).includes(povInput) ? (povInput as PovMode) : "detect";

  // The continuity dictionary is optional. A missing or malformed one yields an
  // empty bible, which is the same as running without it.
  const storyBible = normaliseBible(record.storyBible);

  // The reader may pick a model, but only from the known set. Anything else
  // falls back to the provider default rather than being forwarded and 404ing.
  const modelInput = typeof record.model === "string" ? record.model.trim() : "";
  const model =
    modelInput.length > 0 &&
    modelInput.length <= MAX_MODEL_LENGTH &&
    MODEL_CHOICES.some((choice) => choice.id === modelInput)
      ? modelInput
      : null;

  return { text, tone, categories, povMode, storyBible, model, apiKey: normaliseApiKey(record.apiKey) };
}
