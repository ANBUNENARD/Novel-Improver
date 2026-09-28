/**
 * Deterministic, offline correction engine.
 *
 * This is the safety net: it powers the app before an API key exists, and it
 * takes over whenever the provider errors so the editor still returns a useful
 * result. It is intentionally conservative — it only changes what it is
 * confident is wrong, and it never rewrites phrasing.
 *
 * The one exception is the POV pass in enforce mode, which removes a speaker
 * tag that repeats the name the reader was given on the previous line. That is
 * the one attribution problem provable from the text alone, and leaving the tag
 * is what makes translated Korean webnovel prose read like a transcript.
 */

import { alignParagraphs } from "./diff";
import { analysePov, applyPovFixes } from "./pov";
import { countSyllables, countWords, readabilityOf, splitSentences } from "./text-stats";
import type {
  AnalysisNote,
  Change,
  IssueCategory,
  PovMode,
  SpeakerNote,
  Suggestion,
} from "./types";

/** High-confidence contractions. Each entry is [pattern, replacement]. */
const CONTRACTIONS: Array<[RegExp, string]> = [
  [/\bcan not\b/gi, "cannot"],
  [/\bdo not\b/gi, "don't"],
  [/\bdoes not\b/gi, "doesn't"],
  [/\bdid not\b/gi, "didn't"],
  [/\bis not\b/gi, "isn't"],
  [/\bare not\b/gi, "aren't"],
  [/\bwas not\b/gi, "wasn't"],
  [/\bwere not\b/gi, "weren't"],
  [/\bhas not\b/gi, "hasn't"],
  [/\bhave not\b/gi, "haven't"],
  [/\bhad not\b/gi, "hadn't"],
  [/\bwill not\b/gi, "won't"],
  [/\bwould not\b/gi, "wouldn't"],
  [/\bcould not\b/gi, "couldn't"],
  [/\bshould not\b/gi, "shouldn't"],
  [/\bit is\b/gi, "it's"],
  [/\bthat is\b/gi, "that's"],
  [/\bthere is\b/gi, "there's"],
  [/\bthey are\b/gi, "they're"],
  [/\bwe are\b/gi, "we're"],
  [/\byou are\b/gi, "you're"],
  [/\bI am\b/g, "I'm"],
  [/\bI have\b/g, "I've"],
  [/\bI will\b/g, "I'll"],
  [/\bI would\b/g, "I'd"],
];

const FILLER_WORDS = [
  "very",
  "really",
  "quite",
  "just",
  "actually",
  "basically",
  "literally",
  "simply",
  "totally",
];

/** Repeated-word typo ("the the") and doubled modifiers. */
const DOUBLE_WORD = /\b(\w+)(\s+\1\b){1,}/gi;

/**
 * Subject-verb agreement slips where the verb looks like a plural noun.
 * Only the unambiguous past-tense forms are listed; a "were" that is genuinely
 * the subjunctive ("if she were here") is deliberately left alone.
 */
const AGREEMENT_ERRORS: Array<[RegExp, string]> = [
  [/\b(he|she|it|this|that|one)\s+were\b/gi, "$1 was"],
  [/\b(he|she|it|this|that|one)\s+have\b/gi, "$1 has"],
  [/\b(he|she|it|this|that|one)\s+do\b/gi, "$1 does"],
  [/\bthey\s+was\b/gi, "they were"],
  [/\bwe\s+was\b/gi, "we were"],
  [/\bI\s+was\s+not\s+gone\b/gi, "I hadn't gone"],
];

/** Heuristic spellcheck for common misspellings. `ci -> ce` covers a common typo. */
const MISSPELLINGS: Array<[RegExp, string, string]> = [
  [/\brecieve(d|s)?\b/gi, "$1", "receiv"],
  [/\breciept\b/gi, "receipt", "receipt"],
  [/\bteh\b/gi, "the", "the"],
  [/\badn\b/gi, "and", "and"],
  [/\balot\b/gi, "a lot", "a lot"],
  [/\bseperate\b/gi, "separate", "separate"],
  [/\bdefinately\b/gi, "definitely", "definitely"],
  [/\boccured\b/gi, "occurred", "occurred"],
  [/\bwich\b/gi, "which", "which"],
  [/\bthier\b/gi, "their", "their"],
  [/\bbecuase\b/gi, "because", "because"],
  [/\bvery\s+very\b/gi, "very", "very"],
];

function pushSuggestion(
  suggestions: Suggestion[],
  category: IssueCategory,
  title: string,
  original: string,
  replacement: string,
  note?: string,
  at?: number,
): void {
  if (original === replacement) return;

  suggestions.push({
    id: `r${suggestions.length + 1}`,
    category,
    title,
    original,
    suggestion: replacement,
    note,
    at,
  });
}

/** Applies every safe text substitution and records what changed. */
function fixText(text: string, tone: string, suggestions: Suggestion[]): string {
  let result = text;

  for (const [pattern, replacement] of CONTRACTIONS) {
    result = result.replace(pattern, (match) => {
      // Preserve the original capitalisation of the first letter.
      const original = match;
      const rewritten =
        original[0] === original[0].toUpperCase()
          ? replacement[0].toUpperCase() + replacement.slice(1)
          : replacement;

      pushSuggestion(
        suggestions,
        "grammar",
        "Use a contraction",
        original,
        rewritten,
        "Standard written form for this negation.",
      );
      return rewritten;
    });
  }

  result = result.replace(DOUBLE_WORD, (match) => {
    const first = match.split(/\s+/)[0];
    pushSuggestion(
      suggestions,
      "repetition",
      "Remove the duplicated word",
      match,
      first,
      "The word appears twice in a row.",
    );
    return first;
  });

  for (const [pattern, replacement, label] of MISSPELLINGS) {
    result = result.replace(pattern, (match) => {
      const fixed = match.replace(pattern, replacement);
      pushSuggestion(
        suggestions,
        "spelling",
        `Check the spelling of “${label}”`,
        match,
        fixed,
        "This reads as a common misspelling.",
      );
      return fixed;
    });
  }

  for (const [pattern, replacement] of AGREEMENT_ERRORS) {
    result = result.replace(pattern, (match, subject: string) => {
      const fixed = match.replace(pattern, replacement);
      pushSuggestion(
        suggestions,
        "grammar",
        "Fix subject-verb agreement",
        match,
        fixed,
        `“${subject}” takes a singular verb here.`,
      );
      return fixed;
    });
  }

  result = result.replace(/ {2,}/g, (match) => {
    pushSuggestion(
      suggestions,
      "punctuation",
      "Collapse repeated spaces",
      match,
      " ",
      "Extra whitespace can introduce stray breaks in justified text.",
    );
    return " ";
  });

  if (tone === "concise" || tone === "engaging") {
    for (const word of FILLER_WORDS) {
      const pattern = new RegExp(`\\b${word}\\s+`, "gi");
      result = result.replace(pattern, (match, offset: number) => {
        // The word is about to leave the text, so the finding is anchored on
        // the empty string at its old position. Pairing looks for that anchor,
        // which puts the finding on this paragraph and no other.
        const here = offset;
        pushSuggestion(
          suggestions,
          "style",
          "Cut the intensifier",
          "",
          "",
          `\`${match.trim()}\` adds length without changing the meaning.`,
          here,
        );
        return "";
      });
    }

    result = result.replace(/\s{2,}/g, " ");
  }

  return result.replace(/[ \t]+$/gm, "");
}

/** Sentence-level observations the safe editor should not silently rewrite. */
function findSentenceIssues(
  text: string,
  suggestions: Suggestion[],
  categories: Set<IssueCategory>,
): void {
  const sentences = splitSentences(text);

  sentences.forEach((sentence) => {
    const words = countWords(sentence);

    if (categories.has("structure") && words > 40) {
      pushSuggestion(
        suggestions,
        "structure",
        "Consider splitting this sentence",
        sentence.slice(0, 60) + (sentence.length > 60 ? "…" : ""),
        "",
        `This sentence runs ${words} words. Two shorter sentences will read faster.`,
      );
    }

    // A short segment is only suspicious when it reads as narration. A chapter
    // heading and a line carrying its own speaker tag are both complete.
    const isHeading = /^\s*(chapter|part|volume|prologue|epilogue)\b/i.test(sentence);
    const hasSpeakerTag = /\b(said|asked|replied|whispered|shouted|called|murmured|answered)\b/i.test(sentence);
    const isQuotedLine = /^\s*["“]/.test(sentence);

    if (categories.has("style") && words < 4 && words > 0 && !isHeading && !hasSpeakerTag && !isQuotedLine) {
      pushSuggestion(
        suggestions,
        "style",
        "Check for a missing subject",
        sentence,
        "",
        "This fragment may be missing a subject in narration.",
      );
    }

    if (categories.has("punctuation")) {
      const leading = sentence.match(/^[,;:.!?]/);
      if (leading) {
        pushSuggestion(
          suggestions,
          "punctuation",
          "Remove the leading mark",
          sentence,
          sentence.replace(/^[,;:]/, "").trim(),
          "A sentence should not open with punctuation.",
        );
      }
    }
  });
}
export interface LocalResult {
  corrected: string;
  /** One entry per original paragraph, for the side-by-side view. */
  changes: Change[];
  /** Per-line speaker notes, so the editor can show who is talking. */
  speakers: SpeakerNote[];
}

export function correctLocally(
  text: string,
  tone: string,
  categories: IssueCategory[],
  povMode: PovMode = "detect",
): LocalResult {
  const active = new Set<IssueCategory>(categories);
  const suggestions: Suggestion[] = [];
  const corrected = fixText(text, tone, suggestions);

  findSentenceIssues(corrected, suggestions, active);

  // POV runs after the text rules so the offsets it recorded still line up with
  // the text being edited. In enforce mode the removed tags are written back
  // before the changes are paired, so the view reflects the improved text.
  let improved = corrected;
  const pov = povMode === "off" ? null : analysePov(corrected, povMode);
  const speakers = pov?.speakers ?? [];

  if (povMode === "enforce" && pov) {
    improved = applyPovFixes(corrected, speakers);
  }

  // Long sentences are only worth flagging when the user opted into structure.
  const keep = suggestions.concat(pov?.suggestions ?? []);
  const visible = active.has("structure") || active.has("style")
    ? keep
    : keep.filter((item) => item.category !== "structure" && item.category !== "style");

  return { corrected: improved, changes: pairWithSuggestions(text, improved, visible), speakers };
}

/**
 * Pairs each original paragraph with its rewrite and attaches the findings that
 * were reported against it.
 *
 * The rules engine edits in place and never adds or removes a paragraph, so the
 * pairing is positional and every original paragraph keeps a partner.
 *
 * A finding is placed by offset. A fix that changed length moved its text, so
 * the offset is walked forward by each edit's own length difference to find the
 * quote in the rewrite. A fix that removed its quote outright leaves nothing to
 * find and is placed on the paragraph that edit happened in. Either way a
 * finding lands on one row, and a quote running loose across a paragraph
 * boundary cannot settle on the first paragraph that contains it.
 */
function pairWithSuggestions(
  before: string,
  after: string,
  suggestions: Suggestion[],
): Change[] {
  const pairs = alignParagraphs(before, after);
  const rewrites = pairs.map((pair) => pair.after ?? pair.before);
  const claimed = new Set<Suggestion>();

  // Where each edit left the text, so a later quote is found past the ones
  // that already moved.
  const offsets: number[] = suggestions.map((item) =>
    item.at === undefined ? 0 : item.suggestion.length - item.original.length,
  );

  const notes: AnalysisNote[][] = pairs.map(() => []);

  suggestions.forEach((item, position) => {
    const searchFrom = Math.max(0, item.at ?? 0) + offsets[position];
    const paragraph = rewrites.findIndex(
      (text, index) => index >= searchFrom || text.includes(item.original),
    );

    // A finding with no place of its own is placed on the paragraph whose
    // rewrite still holds its quote, and otherwise on the first paragraph
    // the reader pasted it into.
    const target =
      paragraph === -1
        ? pairs.findIndex((pair) => pair.before.includes(item.original))
        : paragraph;

    if (target === -1 || claimed.has(item)) return;
    claimed.add(item);
    notes[target].push(toNote(target, item));
  });

  return pairs.map((pair, index) => ({
    index: pair.index,
    before: pair.before,
    after: pair.after ?? pair.before,
    unchanged: pair.unchanged,
    notes: notes[index],
  }));
}

/** Adapts a rule's finding into the shape the side-by-side view renders. */
function toNote(paragraph: number, item: Suggestion): AnalysisNote {
  return {
    paragraph,
    category: item.category,
    title: item.title,
    excerpt: item.original,
    intended: item.note ?? "The literal wording needs correcting.",
    rewrite: item.suggestion,
  };
}

/** Exposed for the engine's self-test. */
export const internal = { countSyllables };
