/**
 * Text metrics: counts, readability, and the sentence splitter the rest of the
 * pipeline segments on. Kept dependency-free and deterministic so the same
 * input always yields the same numbers on client and server.
 */

/** Flesch Reading Ease, clipped to 0-100. Bands follow the standard scale. */
const SYLLABLE_ESTIMATE_OVERRIDES: Record<string, number> = {
  the: 1,
  a: 1,
  an: 1,
  and: 1,
  or: 1,
  but: 1,
  for: 1,
  nor: 1,
  so: 1,
  yet: 1,
  of: 1,
  to: 1,
  in: 1,
  on: 1,
  at: 1,
  by: 1,
  is: 1,
  it: 1,
  as: 1,
  was: 1,
  be: 1,
  we: 1,
  he: 1,
  i: 1,
};

/** Abbreviations whose trailing period does not end a sentence. */
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "eg", "ie",
]);

/** A block of prose with no sentence end. */
const CLAUSE = 0;
/** The segment opened with a quotation mark, so it reads as a line of speech. */
const QUOTED = 1;
/** The segment closed its own quotation mark. */
const CLOSED = 2;

type Flags = number;

/** The end of a segment: which marks may be absorbed into it. */
const STOP = /[.!?…]/;
const OPENING_MARKS = /["“]/u;
/** The only way a sentence can close a quotation that has just opened. */
const CLOSERS_BEFORE_QUOTE_END = /^["”’]{1}[,.\u2026!?]/u;
const CLOSING_MARKS = /["'”’)\]}]/u;
const TRAILING_MARKS = /[-"'”’…)\]}]+$/u;

/**
 * True when the boundary that ended the segment is a real sentence end rather
 * than a decimal point, an abbreviation, or an initial in a name.
 *
 * `after` is the text following the period, which is what reveals `e.g.` as one
 * abbreviation: at the first dot the word so far is only `e`.
 */
function endsSentence(segment: string, after: string): boolean {
  if (segment.length === 0) return false;

  const last = segment[segment.length - 1];
  if (!STOP.test(last)) return false;

  // A lone `..` or `...` is an ellipsis before closing punctuation: consume it
  // whole so the marks land on this segment rather than the next one.
  if (/[.!?]/.test(last) && /[.!?]{2,}$/.test(segment)) return true;

  if (last === ".") {
    if (/\d\.$/.test(segment)) return false; // decimal, e.g. `3.`

    // A period between letters belongs to an abbreviation or an acronym, so
    // only the last one of the group can close a sentence. `p.m.` and `e.g.`
    // reach this check one dot at a time, which is why the text after matters.
    if (/^[A-Za-z]\./.test(after)) return false;

    // The word before the period, dots included, so `Dr.` and `e.g.` read as one.
    const tail = /([A-Za-z][A-Za-z.]*)\.$/.exec(segment.replace(TRAILING_MARKS, ""))?.[1] ?? "";
    if (tail.length > 0) {
      if (ABBREVIATIONS.has(tail.replace(/\./g, "").toLowerCase())) return false; // `Dr.` `e.g.`
      if (tail.length === 1 && tail !== tail.toLowerCase()) return false; // an initial, `J.`
    }
  }

  return true;
}

/**
 * Splits text into sentences.
 *
 * Novel prose keeps quotation marks in the sentence that owns them, and dialogue
 * on consecutive lines splits into one segment per line. A regular expression
 * cannot express both without a placeholder whose digits collide with the
 * decimals it is meant to protect, so this scans the string once instead.
 */
export function splitSentences(text: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let flags: Flags = CLAUSE;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (char === "\n") {
      // A paragraph break separates, and its own whitespace rides along on the
      // segment before it so the text survives a rejoin.
      if (isBlankLine(text, i)) {
        const after = skipBlankLines(text, i);
        const pending = text.slice(start, after);
        if (pending.trim().length > 0) {
          segments.push(pending);
        } else if (segments.length > 0) {
          segments[segments.length - 1] += pending;
        }
        start = after;
        flags = CLAUSE;
        i = after - 1;
      }
      continue;
    }

    if (atRunStart(text, start, i) && OPENING_MARKS.test(char)) {
      // Checked before the closing mark below: an opening quotation mark would
      // otherwise read as a closing one and split right after it. A comma or
      // full stop inside the quotation still falls through to the sentence
      // rules, so `"Yes," said Lee.` is not cut short.
      if (!CLOSERS_BEFORE_QUOTE_END.test(text.slice(i + 1, i + 8))) flags |= QUOTED;
      continue;
    }

    if (char === "\t" || char === " ") {
      // `… said." He` — the closing quotation mark belongs to what came before.
      if (flags & CLOSED) {
        pushSegment(text, start, i, segments);
        start = i;
        flags = CLAUSE;
      } else if ((flags & QUOTED) && isDialogueBoundary(text, start, i)) {
        pushSegment(text, start, i, segments);
        start = i;
        flags = CLAUSE;
      }
      continue;
    }

    if (CLOSING_MARKS.test(char)) {
      // `"Yes," said Soo-hyun.` closes the quotation but the sentence carries on
      // to the attribution, so only a mark that follows sentence punctuation
      // ends the segment.
      if (i > start && STOP.test(text[i - 1])) flags |= CLOSED;
      continue;
    }

    if (!STOP.test(char)) continue;

    let end = i;
    while (end + 1 < text.length && STOP.test(text[end + 1])) end += 1;

    // Absorb the closing marks that belong with this punctuation.
    let cursor = end + 1;
    while (
      cursor < text.length &&
      CLOSING_MARKS.test(text[cursor]) &&
      !CLOSING_MARKS.test(text[cursor - 1])
    ) {
      cursor += 1;
    }

    if (!endsSentence(text.slice(start, end + 1), text.slice(cursor))) {
      i = end;
      continue;
    }

    pushSegment(text, start, cursor, segments);
    start = cursor;
    flags = CLAUSE;
    i = cursor - 1;
  }

  pushSegment(text, start, text.length, segments);

  return segments;
}

/** True when the newline at `index` is part of a blank line. */
function isBlankLine(text: string, index: number): boolean {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (text[i] === "\n") return true;
    if (text[i] !== " " && text[i] !== "\t" && text[i] !== "\r") return false;
  }
  return false;
}

/** The index just past the run of blank-line whitespace starting at `index`. */
function skipBlankLines(text: string, index: number): number {
  let after = index;
  while (after < text.length && (text[after] === "\n" || text[after] === "\r")) after += 1;
  return after;
}

/** True when `index` is the first non-space character of its line. */
function atRunStart(text: string, start: number, index: number): boolean {
  for (let i = index - 1; i >= start; i -= 1) {
    if (text[i] === "\n") return true;
    if (text[i] !== " " && text[i] !== "\t" && text[i] !== "\r") return false;
  }
  return false;
}

/**
 * True when the run of dialogue that started at `start` already spans two
 * lines, so the whitespace at `index` ends a line of speech.
 */
function isDialogueBoundary(text: string, start: number, index: number): boolean {
  if (!text.startsWith('"', index) && !text.startsWith("\u201C", index)) return false;

  for (let i = start; i < index; i += 1) {
    if (text[i] !== "\n") continue;
    if (atRunStart(text, start, i + 1)) return true;
  }
  return false;
}

function pushSegment(
  text: string,
  start: number,
  end: number,
  segments: string[],
): void {
  if (end <= start) return;
  const segment = text.slice(start, end);
  if (segment.trim().length > 0) segments.push(segment);
}

/** Rough syllable count. Good enough for a readability signal, not a linguistics claim. */
export function countSyllables(word: string): number {
  const clean = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!clean) return 0;

  const override = SYLLABLE_ESTIMATE_OVERRIDES[clean];
  if (override) return override;

  const trimmed = clean
    .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "")
    .replace(/^y/, "");

  const matches = trimmed.match(/[aeiouy]{1,2}/g);
  return matches ? matches.length : 1;
}

export function countWords(text: string): number {
  const matches = text.match(/[\p{L}\p{N}'’\-]+/gu);
  return matches ? matches.length : 0;
}

export interface Readability {
  score: number;
  label: string;
}

export function readabilityOf(text: string): Readability {
  const sentences = splitSentences(text);
  const words = countWords(text);

  if (sentences.length === 0 || words === 0) {
    return { score: 0, label: "—" };
  }

  const syllables = text
    .split(/\s+/)
    .map((word) => countSyllables(word))
    .reduce((total, count) => total + count, 0);

  const wordsPerSentence = words / sentences.length;
  const syllablesPerWord = syllables / words;

  const raw = 206.835 - 1.015 * wordsPerSentence - 84.6 * syllablesPerWord;
  const score = Math.max(0, Math.min(100, Math.round(raw)));

  let label: string;
  if (score >= 90) label = "Very easy";
  else if (score >= 80) label = "Easy";
  else if (score >= 70) label = "Fairly easy";
  else if (score >= 60) label = "Standard";
  else if (score >= 50) label = "Fairly hard";
  else if (score >= 30) label = "Hard";
  else label = "Very hard";

  return { score, label };
}
