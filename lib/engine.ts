import "server-only";

/**
 * Orchestrates the correction pipeline.
 *
 * Order on every path: continuity normalisation, the model or the local rules,
 * then the speaker attribution pass, which is settled from the text alone.
 * A provider failure is reported back to the client in `fallbackReason` rather
 * than surfaced as a 500, so the editor always renders a result.
 */

import { configFromRequest } from "./credentials";
import { LlmError, readLlmConfig, runCorrection } from "./llm";
import type { LlmProvider } from "./llm";
import { correctLocally } from "./local-engine";
import { buildPipelineReport } from "./pipeline";
import { analysePov, applyPovFixes } from "./pov";
import { findContinuityNotes, normaliseNames } from "./story-bible";
import { countWords, readabilityOf, splitSentences } from "./text-stats";
import type {
  AnalysisSummary,
  ContinuityNote,
  CorrectionResult,
  IssueCategory,
  PovMode,
  SpeakerNote,
  StoryBible,
  Suggestion,
  TonePreset,
} from "./types";

export { MAX_TEXT_LENGTH, validateRequest } from "./validate";

function summarise(text: string, suggestions: Suggestion[]): AnalysisSummary {
  const sentences = splitSentences(text);
  const words = countWords(text);

  const issuesByCategory: Partial<Record<IssueCategory, number>> = {};
  for (const suggestion of suggestions) {
    issuesByCategory[suggestion.category] = (issuesByCategory[suggestion.category] ?? 0) + 1;
  }

  return {
    wordCount: words,
    sentenceCount: sentences.length,
    averageSentenceLength: sentences.length > 0 ? Math.round((words / sentences.length) * 10) / 10 : 0,
    readability: readabilityOf(text),
    issuesByCategory,
  };
}

/** What a correction path produces before the continuity and report passes run. */
type PathResult = Omit<CorrectionResult, "continuity" | "pipeline"> & { continuity?: ContinuityNote[] };

/**
 * True when the model belongs to the provider that is actually configured.
 *
 * Without this a reader could pick a Gemini model while holding an OpenAI key,
 * and the provider would answer with an error the app then reports as a fallback.
 * Silently keeping the configured model is clearer than failing the whole pass.
 */
function providerOwns(provider: LlmProvider, model: string): boolean {
  return provider === "gemini" ? model.startsWith("gemini-") : model.startsWith("gpt-");
}

export async function correct(
  text: string,
  tone: TonePreset,
  categories: IssueCategory[],
  povMode: PovMode = "detect",
  bible?: StoryBible,
  modelOverride?: string | null,
  apiKey?: string | null,
): Promise<CorrectionResult> {
  // Aliases are resolved before the model reads anything, so a transliteration
  // variant is already spelled one way by the time continuity is judged. The
  // notes come back to the reader so the rewrite is never silent.
  const normalised = normaliseNames(text, bible);
  const source = normalised.text;
  const nameNotes: ContinuityNote[] = normalised.notes;

  // A key pasted into the page takes over, so a reader does not have to edit a
  // file. The endpoint, timeout, and provider stay server-side settings, so a
  // pasted key can only ever be used against the endpoint this app is set up
  // for. A key in the environment still wins when the page sends none.
  const config = configFromRequest(apiKey ?? "", modelOverride ?? null) ?? readLlmConfig();

  // A model the reader picked only makes sense with a key present. It is also
  // checked against the provider: asking OpenAI for a Gemini id, or the reverse,
  // would turn a wrong click into a provider error and a silent fallback.
  const requested = modelOverride?.trim();
  const wanted = config && requested ? requested.toLowerCase() : "";
  const model =
    config && (wanted === "" || wanted === config.model.toLowerCase() || providerOwns(config.provider, wanted))
      ? { ...config, model: wanted === "" ? config.model : requested! }
      : config;

  const finish = (body: PathResult): CorrectionResult => {
    const continuity = nameNotes.concat(body.continuity ?? []).concat(findContinuityNotes(body.corrected, bible));

    return {
      ...body,
      continuity,
      pipeline: buildPipelineReport({
        original: source,
        corrected: body.corrected,
        suggestions: body.suggestions,
        speakers: body.speakers ?? [],
        continuity,
        summary: body.summary,
        bible,
        povMode,
        engine: body.engine,
      }),
    };
  };

  if (!model) {
    const local = correctLocally(source, tone, categories, povMode);
    return finish({
      corrected: local.corrected,
      suggestions: local.suggestions,
      summary: local.summary,
      speakers: local.speakers,
      engine: "rules",
      fallbackReason: "No LLM_API_KEY is set, so the built-in rules engine handled this pass.",
    });
  }

  try {
    const result = await runCorrection(model, source, tone, categories, povMode, bible);

    // Speaker attribution is settled from the text alone, so it runs on every
    // path. The model rewrites prose; it does not reliably track who is talking
    // across a long chapter, and guessing there would corrupt the narration.
    const pov: { speakers: SpeakerNote[]; suggestions: Suggestion[] } | null =
      povMode === "off" ? null : analysePov(result.corrected, povMode);
    const corrected =
      pov && povMode === "enforce" ? applyPovFixes(result.corrected, pov.speakers) : result.corrected;
    const suggestions = result.suggestions.concat(pov?.suggestions ?? []);

    return finish({
      corrected,
      suggestions,
      summary: summarise(corrected, suggestions),
      speakers: pov?.speakers ?? [],
      continuity: result.continuity,
      engine: "llm",
      model: model.model,
    });
  } catch (error) {
    const reason = error instanceof LlmError ? error.message : "The provider request failed.";
    const local = correctLocally(source, tone, categories, povMode);

    return finish({
      corrected: local.corrected,
      suggestions: local.suggestions,
      summary: local.summary,
      speakers: local.speakers,
      engine: "rules",
      model: model.model,
      fallbackReason: reason,
    });
  }
}
