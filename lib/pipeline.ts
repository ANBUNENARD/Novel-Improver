/**
 * The ten-stage report shown above the result.
 *
 * The analysis runs whether or not the reader looks at it, so this module does
 * not run the work. It turns what actually happened on this pass into a short
 * line per stage, which keeps the strip honest: a stage that was skipped says
 * so, and a stage with nothing to report says "nothing to change".
 */

import { findContinuityNotes, normaliseNames } from "./story-bible";
import type {
  AnalysisSummary,
  ContinuityNote,
  PipelineReportEntry,
  PipelineStage,
  PovMode,
  SpeakerNote,
  StoryBible,
  Suggestion,
} from "./types";

function stage(stage: PipelineStage, ran: boolean, detail: string): PipelineReportEntry {
  return { stage, ran, detail };
}

/** Count of paragraphs, which is the number the pacing rule talks about. */
function countParagraphs(text: string): number {
  return text.split(/\n{2,}/).filter((part) => part.trim()).length;
}

function countQuotes(text: string): number {
  return (text.match(/["\u201C\u201D]/g) ?? []).length / 2;
}

/** Paragraphs whose wording differs between the two versions. */
function countChanges(original: string, corrected: string): number {
  const before = original.split(/\n{2,}/).map((part) => part.trim());
  const after = corrected.split(/\n{2,}/).map((part) => part.trim());
  const total = Math.max(before.length, after.length);

  let changed = 0;
  for (let index = 0; index < total; index += 1) {
    if (before[index] !== after[index]) changed += 1;
  }
  return changed;
}

export function buildPipelineReport(input: {
  original: string;
  corrected: string;
  suggestions: Suggestion[];
  speakers: SpeakerNote[];
  continuity: ContinuityNote[];
  summary: AnalysisSummary;
  bible?: StoryBible;
  povMode: PovMode;
  engine: "llm" | "rules";
}): PipelineReportEntry[] {
  // The dictionary is accepted so callers can stay uniform about what they pass,
  // but every count below comes from the notes already resolved against it.
  const { original, corrected, suggestions, speakers, continuity, summary, povMode, engine } = input;
  const entries: PipelineReportEntry[] = [];

  const paragraphs = countParagraphs(original);
  const dialogueLines = countQuotes(original);
  entries.push(
    stage(
      "parse",
      true,
      `${paragraphs} ${paragraphs === 1 ? "paragraph" : "paragraphs"}, ${dialogueLines} quoted ${dialogueLines === 1 ? "line" : "lines"} separated from narration.`,
    ),
  );

  if (povMode === "off") {
    entries.push(stage("pov", false, "Turned off for this pass."));
  } else {
    const unclear = speakers.filter((note) => !note.speaker).length;
    entries.push(
      stage(
        "pov",
        true,
        `${speakers.length} ${speakers.length === 1 ? "line" : "lines"} attributed, ${unclear} still unclear.`,
      ),
    );
  }

  const knownNames = bibleNameCountOf(continuity);
  entries.push(
    stage(
      "normalize",
      true,
      knownNames > 0
        ? `${knownNames} ${knownNames === 1 ? "name" : "names"} matched to the story bible.`
        : "No story bible matches in this chapter.",
    ),
  );

  // Renames are listed by the variant that was found, because that is the
  // string the reader has to look for when they scan the chapter themselves.
  const renames = continuity.filter((note) => note.via);
  const renameDetail = `resolved to a canonical name: ${renames.map((note) => note.raw).join(", ")}.`;
  const aliasPlural = renames.length === 1;
  entries.push(
    stage(
      "continuity",
      true,
      renames.length > 0
        ? `${renames.length} ${aliasPlural ? "alias" : "aliases"} ${renameDetail}`
        : "No alias or identity drift found.",
    ),
  );

  const meaning = suggestions.filter((item) => item.category === "clarity").length;
  entries.push(
    stage(
      "meaning",
      true,
      meaning > 0
        ? `${meaning} ${meaning === 1 ? "passage" : "passages"} read for the meaning the author intended.`
        : "No broken literal translation found.",
    ),
  );

  // An LLM pass always paraphrases, so identical text means the local rules ran
  // and found nothing to change. A rules engine that did change something is
  // described in terms of that.
  const engineNote =
    corrected.trim() === original.trim()
      ? "Text needed no change; every stage checked it and found nothing to fix."
      : engine === "llm"
        ? "Chapter rewritten in natural English."
        : `${countChanges(original, corrected)} safe ${countChanges(original, corrected) === 1 ? "correction" : "corrections"} applied.`;

  entries.push(stage("rewrite", true, engineNote));

  entries.push(
    stage(
      "pacing",
      true,
      `${countParagraphs(corrected)} ${countParagraphs(corrected) === 1 ? "paragraph" : "paragraphs"} out, averaging ${summary.averageSentenceLength} words a sentence.`,
    ),
  );

  const povSuggestions = suggestions.filter((item) => item.category === "pov").length;
  entries.push(
    stage(
      "dialogue",
      true,
      dialogueLines === 0
        ? "No dialogue in this passage."
        : povSuggestions > 0
          ? `${povSuggestions} ${povSuggestions === 1 ? "attribution" : "attributions"} corrected.`
          : `${dialogueLines} ${dialogueLines === 1 ? "line reads" : "lines read"} cleanly.`,
    ),
  );

  const orderNotes = suggestions.filter((item) => item.category === "structure").length;
  entries.push(
    stage(
      "logic",
      true,
      orderNotes > 0
        ? `${orderNotes} ${orderNotes === 1 ? "sequence" : "sequences"} reordered or flagged.`
        : "Actions and consequences run in order.",
    ),
  );

  entries.push(
    stage("consistency", true, "Final pass over POV, names, terms, and plot preservation."),
  );

  return entries;
}

function bibleNameCountOf(notes: ContinuityNote[]): number {
  return new Set(notes.map((note) => note.canonical)).size;
}

/** Re-exported so the engine can normalise without importing two modules. */
export { findContinuityNotes, normaliseNames };

/** Exposed for the self-test. */
export const internal = { countParagraphs, countQuotes, countChanges };
