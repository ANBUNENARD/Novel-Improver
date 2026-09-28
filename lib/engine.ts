import "server-only";

/**
 * Orchestrates the correction pipeline.
 *
 * Order on every path: continuity normalisation, the model or the local rules,
 * then the speaker attribution pass, which is settled from the text alone. A
 * provider failure is reported back to the client in `fallbackReason` rather
 * than surfaced as a 500, so the editor always renders a result.
 */

import { configFromRequest } from "./credentials";
import { alignParagraphs } from "./diff";
import { LlmError, readLlmConfig, runCorrection } from "./llm";
import type { LlmProvider } from "./llm";
import { correctLocally } from "./local-engine";
import { analysePov, applyPovFixes } from "./pov";
import { findContinuityNotes, normaliseNames } from "./story-bible";
import type {
  Change,
  ContinuityNote,
  CorrectionResult,
  IssueCategory,
  PovMode,
  StoryBible,
  TonePreset,
} from "./types";

export { MAX_TEXT_LENGTH, validateRequest } from "./validate";

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

/** The result every path returns, before the continuity pass is folded in. */
type PathResult = Omit<CorrectionResult, "continuity"> & { continuity?: ContinuityNote[] };

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
    // Three sources report a name: the rename that ran before the model, the
    // analyst's own continuity findings, and a scan of the finished chapter for
    // names the rewrite introduced. The last of these re-reads names the first
    // already settled, so it contributes only what the others have not covered.
    // Without that, every settled name is reported a second time as if it had
    // drifted, and the reader sees the same character listed twice.
    const reported = new Set(
      nameNotes.concat(body.continuity ?? []).map((note) => `${note.canonical}:${note.raw.toLowerCase()}`),
    );

    const settled = findContinuityNotes(body.corrected, bible).filter(
      (note) => !reported.has(`${note.canonical}:${note.raw.toLowerCase()}`),
    );

    return { ...body, continuity: nameNotes.concat(body.continuity ?? []).concat(settled) };
  };

  if (!model) {
    const local = correctLocally(source, tone, categories, povMode);
    return finish({
      corrected: local.corrected,
      // The local engine pairs against the text it was handed, which is the
      // paste with its aliases already resolved, so the left column has to be
      // rebuilt from the paste. Reverting a rename has to give the reader the
      // name they typed, and that is only true once the pairing is redone.
      changes: pairAgainstPaste(text, local.corrected, local.changes),
      speakers: local.speakers,
      engine: "rules",
      requests: 0,
      fallbackReason: "No LLM_API_KEY is set, so the built-in rules engine handled this pass.",
    });
  }

  try {
    const result = await runCorrection(model, source, tone, categories, povMode, bible);

    // Speaker attribution is settled from the text alone, so it runs on every
    // path. The model rewrites prose; it does not reliably track who is talking
    // across a long chapter, and guessing there would corrupt the narration.
    const pov = povMode === "off" ? null : analysePov(result.corrected, povMode);
    const corrected =
      pov && povMode === "enforce" ? applyPovFixes(result.corrected, pov.speakers) : result.corrected;

    return finish({
      corrected,
      changes:
        corrected === result.corrected
          ? pairAgainstPaste(text, corrected, result.changes)
          : pairAgainstPaste(text, corrected, result.changes).map((change) => ({
              ...change,
              after: corrected.includes(change.after) ? change.after : change.before,
            })),
      speakers: pov?.speakers ?? [],
      engine: "llm",
      model: model.model,
      requests: result.requests,
      continuity: result.continuity,
    });
  } catch (error) {
    const reason =
      error instanceof LlmError
        ? error.message
        : "The provider request failed. Check the key and try again.";

    const local = correctLocally(source, tone, categories, povMode);

    return finish({
      corrected: local.corrected,
      changes: pairAgainstPaste(text, local.corrected, local.changes),
      speakers: local.speakers,
      engine: "rules",
      model: model.model,
      requests: 0,
      fallbackReason: reason,
    });
  }
}

/**
 * Re-pairs the result against the text the reader pasted.
 *
 * `runCorrection` and `correctLocally` both build their pairs against the text
 * the model was handed, which is the paste with every alias already resolved.
 * The side-by-side view is a promise about the reader's own words, so the left
 * column is rebuilt here from the paste itself: every paragraph they wrote is
 * on the left, verbatim, and reverting one puts their wording back.
 *
 * Findings and the rewritten side are carried over positionally. The rename and
 * the rewrite can move text by different amounts, so the similarity fallback in
 * `alignParagraphs` picks the pairing it trusts most; the notes follow their
 * paragraph, which is the only place they mean anything.
 */
function pairAgainstPaste(pasted: string, corrected: string, changes: Change[]): Change[] {
  const pairs = alignParagraphs(pasted, corrected);

  return pairs.map((pair) => {
    // Notes are indexed by position, which is what the analyst and the rules
    // engine both report against.
    const from = changes[pair.index];
    return {
      index: pair.index,
      before: pair.before,
      after: pair.after ?? pair.before,
      unchanged: pair.unchanged,
      notes: from?.notes ?? [],
    };
  });
}
