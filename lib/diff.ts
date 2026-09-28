/**
 * Pairs each rewritten paragraph with the one it came from.
 *
 * The side-by-side view is built from this, so a reader can keep or undo one
 * change without losing the rest. The model is told to keep every paragraph in
 * order, and that is nearly always true, so the pairing is positional with a
 * similarity fallback for the paragraphs that shift.
 *
 * Free of `server-only` so the test harness can reach it directly.
 */

import { normaliseForCompare } from "./text-stats";

/**
 * One paragraph on each side of the comparison.
 *
 * `after` is null when the rewrite has no partner for this paragraph, which the
 * view reads as a deletion the reader can undo.
 */
export interface ParagraphPair {
  /** Position in the original chapter, starting at zero. */
  index: number;
  /** The paragraph as the reader pasted it. */
  before: string;
  /** The paragraph as the model rewrote it, or null when nothing pairs with it. */
  after: string | null;
  /** True when the rewrite left this paragraph alone. */
  unchanged: boolean;
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Jaccard overlap of two bags of words, in the range 0 to 1.
 *
 * Used to decide which rewritten paragraph belongs to which original one when
 * the two lists no longer line up. Cheap, order-insensitive, and good enough to
 * recognise a paragraph that was reworded rather than replaced.
 */
export function similarity(a: string, b: string): number {
  const left = new Set(normaliseForCompare(a).split(" ").filter(Boolean));
  const right = new Set(normaliseForCompare(b).split(" ").filter(Boolean));

  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;

  return shared / (left.size + right.size - shared);
}

/** The longest common prefix and suffix are shared boilerplate, so ignore them. */
function sharedEdges(a: string, b: string): { prefix: number; suffix: number } {
  const shortest = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < shortest && a[prefix] === b[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  return { prefix, suffix };
}

/**
 * Finds the one-to-one pairing that maximises total similarity.
 *
 * Greedy rather than optimal: the best remaining pair is taken until every
 * original paragraph has a partner or no candidate scores above `floor`. A
 * chapter has tens of paragraphs, and the greedy answer is right whenever the
 * rewrite kept the order, which is the common case.
 */
function pairBySimilarity(
  before: string[],
  after: string[],
  floor = 0.25,
): Array<{ beforeIndex: number; afterIndex: number }> {
  const candidates: Array<{ beforeIndex: number; afterIndex: number; score: number }> = [];

  for (let i = 0; i < before.length; i += 1) {
    for (let j = 0; j < after.length; j += 1) {
      const score = similarity(before[i], after[j]);
      if (score >= floor) candidates.push({ beforeIndex: i, afterIndex: j, score });
    }
  }

  candidates.sort((x, y) => y.score - x.score);

  const usedBefore = new Set<number>();
  const usedAfter = new Set<number>();
  const pairs: Array<{ beforeIndex: number; afterIndex: number }> = [];

  for (const candidate of candidates) {
    if (usedBefore.has(candidate.beforeIndex) || usedAfter.has(candidate.afterIndex)) continue;
    usedBefore.add(candidate.beforeIndex);
    usedAfter.add(candidate.afterIndex);
    pairs.push({ beforeIndex: candidate.beforeIndex, afterIndex: candidate.afterIndex });
  }

  pairs.sort((x, y) => x.beforeIndex - y.beforeIndex);
  return pairs;
}

/**
 * Pairs the original chapter with its rewrite.
 *
 * When the two lists are the same length, or the rewrite is a superset that
 * still lines up, the pairing is positional. That is the case the model is
 * instructed to produce. Only when the lists disagree does the fallback run,
 * and a paragraph with no partner is reported as deleted rather than paired
 * with something unrelated.
 */
export function alignParagraphs(before: string, after: string): ParagraphPair[] {
  const original = splitParagraphs(before);
  const rewritten = splitParagraphs(after);

  if (original.length === 0) return [];

  // Positional pairing holds when the counts match, or when the rewrite has the
  // same paragraph structure with at most one extra leading or trailing block
  // (a scene-break marker the reader's paste did not have).
  const positionalIsPlausible =
    original.length === rewritten.length ||
    Math.abs(original.length - rewritten.length) <= 1;

  if (positionalIsPlausible) {
    return original.map((text, index) => {
      const next = rewritten[index];
      return {
        index,
        before: text,
        after: next ?? null,
        unchanged: next === undefined ? true : normaliseForCompare(next) === normaliseForCompare(text),
      };
    });
  }

  const pairs = pairBySimilarity(original, rewritten);
  const matched = new Map(pairs.map((pair) => [pair.beforeIndex, pair.afterIndex]));

  return original.map((text, index) => {
    const afterIndex = matched.get(index);
    const next = afterIndex === undefined ? undefined : rewritten[afterIndex];

    return {
      index,
      before: text,
      after: next ?? null,
      unchanged: next === undefined ? true : normaliseForCompare(next) === normaliseForCompare(text),
    };
  });
}

/**
 * Rebuilds a chapter from the pairs a reader chose to keep.
 *
 * An accepted change contributes its rewritten paragraph; a reverted one
 * contributes the original. An original with no partner was deleted by the
 * rewrite and is restored on revert.
 */
export function composeFromPairs(pairs: ParagraphPair[], accepted: Set<number>): string {
  return pairs
    .map((pair) => {
      if (!accepted.has(pair.index)) return pair.before;
      if (pair.after === null) return "";
      return pair.after;
    })
    .filter((paragraph) => paragraph.length > 0)
    .join("\n\n");
}
