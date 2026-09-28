/**
 * Point-of-view and speaker attribution analysis.
 *
 * This module is deterministic and offline, like local-engine.ts. It exists for
 * two reasons: the editor has to show speaker notes even when no API key is
 * configured, and the local rules engine needs a fallback for attribution the
 * same way it has one for grammar.
 *
 * What it can settle from the text alone:
 *   - who speaks each quoted line, from an explicit tag or an action beat
 *   - runs of unattributed dialogue where the reader has to guess
 *   - a tag that contradicts the beat immediately before it
 *   - a speaker named twice running, the signature of translated Korean webnovel
 *     prose, which tags nearly every line the same character speaks
 *
 * What it deliberately leaves alone: anything needing world knowledge. A beat
 * that says only "he" is reported as ambiguous rather than resolved, because
 * guessing wrong is worse than admitting the text is unclear. Those come back as
 * questions for the author, not as rewrites.
 */

import type { PovMode, SpeakerNote, Suggestion } from "./types";

/**
 * Words that start with a capital but are not names. "The boy said" is a
 * sentence, not a character called The.
 */
const NOT_A_NAME = new Set([
  "the", "a", "an", "his", "her", "their", "its", "our", "my", "your", "this",
  "that", "these", "those", "then", "there", "they", "he", "she", "it", "we",
  "i", "but", "and", "so", "when", "while", "after", "before", "if", "as",
  "at", "in", "on", "for", "with", "from", "by", "to", "of", "one", "two",
  "three", "everyone", "someone", "nobody", "everybody", "both", "neither",
  "each", "many", "most", "all", "no", "not", "only", "just", "even", "still",
  "meanwhile", "afterwards", "later", "finally", "again", "once", "now", "soon",
  "another", "other", "others", "somebody", "anybody", "nothing", "sure",
  "yes", "no", "come", "go", "look", "listen", "wait", "stop", "please", "thank",
]);

const SPEECH_VERBS = [
  "said", "says", "say", "asked", "asks", "ask", "replied", "replies",
  "answered", "answers", "whispered", "whispers", "shouted", "shouts",
  "yelled", "yells", "murmured", "murmurs", "muttered", "mutters",
  "called", "calls", "cried", "cries", "added", "adds", "continued",
  "continues", "offered", "offers", "responded", "responds", "retorted",
  "sighed", "sighs", "laughed", "laughs", "growled", "growls", "snapped",
  "snaps", "insisted", "insists", "admitted", "admits", "denied", "denies",
  "agreed", "agrees", "objected", "objects", "begged", "begs", "pleaded",
  "pleads", "protested", "protests", "teased", "teases", "joked", "jokes",
  "drawled", "drawls", "concluded", "concludes", "finished", "finishes",
  "blurted", "blurts", "hissed", "hisses", "wondered", "wonders",
  "repeated", "repeats", "returned", "returns", "murmured", "murmurs",
];

const VERB_ALT = SPEECH_VERBS.join("|");
const PRONOUNS = new Set(["he", "she", "they", "it", "him", "her", "them"]);

/**
 * Finds where a line stops being a sentence of its own.
 *
 * A line that closes on a comma or dash is running into its speaker tag, so the
 * text from the last such mark to the closing quote is rewritten. The last mark is
 * the one nearest the quote: an earlier comma in the same line is part of the
 * sentence and must be left alone.
 */
function trailingMarkStart(quote: string): number {
  const marks = /[,;\u2014\u2013-]/g;
  let at = -1;
  let match: RegExpExecArray | null;
  while ((match = marks.exec(quote)) !== null) at = match.index;
  return at;
}

export interface DialogueBlock {
  index: number;
  /** Offset of the opening quotation mark. */
  start: number;
  /** Offset just past the closing quotation mark. */
  end: number;
  /** The quoted text including its quotation marks. */
  quote: string;
  /** The dialogue without its quotation marks. */
  line: string;
  /** Index of the paragraph the line sits in. */
  paragraph: number;
}

/**
 * A capitalised name: one word, or up to three joined by spaces, each with an
 * optional possessive tail so `Sarah's` is captured whole and cleaned later.
 */
const NAME = "[A-Z][\\p{L}]+(?:[’]s)?(?:\\s+[A-Z][\\p{L}]+(?:[’]s)?){0,2}";

/** Strips a possessive or contraction tail, so `Sarah's` reads as `Sarah`. */
function bareName(word: string): string {
  return word.replace(/['’]s$/i, "").replace(/n['’]t$/i, "nt");
}

function isPlausibleName(candidate: string): boolean {
  const words = bareName(candidate).trim().split(/\s+/);
  if (words.length === 0) return false;
  // A contraction is dialogue, never a name: `Don't` is not a character.
  if (/n['’]t/i.test(candidate)) return false;
  if (words.some((word) => NOT_A_NAME.has(word.toLowerCase()))) return false;
  return true;
}

/** The name to report, with any possessive tail removed. */
function cleanName(candidate: string): string {
  return candidate
    .split(/\s+/)
    .map((word) => bareName(word))
    .join(" ");
}

/**
 * Pulls every quoted line out of the passage.
 *
 * A single quote only counts as dialogue when preceded by a space, bracket, or
 * the start of a paragraph, so apostrophes in "don't" and "Sarah's" survive.
 */
export function extractDialogue(text: string): DialogueBlock[] {
  const paragraphs: string[] = text.split("\n");
  const starts: number[] = [];
  let cursor = 0;
  for (const paragraph of paragraphs) {
    starts.push(cursor);
    cursor += paragraph.length + 1;
  }

  const blocks: DialogueBlock[] = [];

  const DOUBLE = /"([^"\n]{1,4000})"/g;
  // `"Don't," she said` — the contraction is dialogue, not a character called
  // Don. Single quotes only open dialogue after a space, bracket, or the start
  // of a paragraph, which is what keeps "don't" and "Sarah's" out of this.
  const SINGLE = /(^|[\s(\[])'([^'\n]{1,4000})'/g;

  paragraphs.forEach((paragraph, index) => {
    // The captured group index differs between the two patterns, so the inner
    // text is passed in rather than read from a fixed index.
    const scan = (match: RegExpExecArray, inner: string, openLen: number, closeLen: number) => {
      // `match.index` points at the first character scanned, which for the
      // single-quote pattern is the character before the opening quote.
      const openAt = starts[index] + match.index + (openLen - 1);
      const closeAt = openAt + openLen + inner.length;
      blocks.push({
        index: 0,
        start: openAt,
        end: closeAt + closeLen,
        quote: text.slice(openAt, closeAt + closeLen),
        line: inner,
        paragraph: index,
      });
    };

    for (const match of paragraph.matchAll(DOUBLE)) scan(match, match[1], 1, 1);
    for (const match of paragraph.matchAll(SINGLE)) scan(match, match[2], 2, 1);
  });
  return blocks
    .map((block, index) => ({ ...block, index }))
    .sort((a, b) => a.start - b.start);
}

/**
 * The most recent capitalised name in the narration before a line, used to
 * resolve a pronoun tag to an actual character.
 *
 * The scan is anchored at the opening quotation mark and stops at the last
 * quotation mark before it, so it reads narration and never the conversation —
 * including the line itself, where `Don't` would otherwise resolve to "Don".
 */
function lastNameBefore(text: string, quoteStart: number): string | null {
  const head = text.slice(Math.max(0, quoteStart - 400), quoteStart);
  const narration = head.split(/["“”]/).pop() ?? "";
  const matches = narration.match(new RegExp(NAME, "gu")) ?? [];

  for (let i = matches.length - 1; i >= 0; i -= 1) {
    if (isPlausibleName(matches[i])) return cleanName(matches[i]);
  }
  return null;
}

/**
 * True when `name` appears shortly before `offset`, within a sentence's reach.
 *
 * This is what lets `"I should go," she said.` be read as Sarah speaking, since
 * the pronoun tag carries no name of its own but the character was just named.
 */
function namedJustBefore(text: string, name: string, offset: number): boolean {
  const window = text.slice(Math.max(0, offset - 60), offset);
  const pattern = new RegExp(
    `(?:^|[.!?…]["'”’)\\]]?\\s+|,\\s+)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$|[.,:'’])`,
    "u",
  );
  return pattern.test(window);
}

interface Attribution {
  name: string | null;
  /** The pronoun the tag used, when it used one instead of a name. */
  pronoun: string | null;
  /** Exact source text of the tag, so a finding can quote it verbatim. */
  raw: string;
  /** Offset just past the tag's last character. */
  end: number;
  side: "before" | "after";
}

/**
 * Finds an attribution attached to a quote.
 *
 * Handles `Sarah said, "…"` and `"…," Sarah said`, plus the vocative form
 * `"…," Sarah, she said,` where a name is followed by a pronoun tag. An adverb
 * may sit between the name and the verb in either position.
 */
function findAttribution(
  before: string,
  after: string,
  quoteStart: number,
  quoteEnd: number,
): Attribution | null {
  // A tag is narration, so it cannot contain a quotation mark. Without this
  // guard the lookbehind window bleeds through the opening quote and reads the
  // dialogue itself as a name — `"Don't," she said` yields "Don".
  //
  // The head is also cut at the last line break. A tag placed before the opening
  // quote shares that quote's line, so anything ending on the line above is a
  // trailing tag belonging to the previous speaker, not this one.
  const head = (before.split(/["“”]/).pop() ?? "").split("\n").pop() ?? "";
  const tail = after.split(/["“”]/)[0] ?? "";

  // --- before the quote ---
  const vocativeBefore = new RegExp(
    `(${NAME})\\s*,\\s*(?:he|she|they)\\s+(?:${VERB_ALT})\\b[^"\\n]{0,20}$`,
    "u",
  );
  const vocativeBeforeMatch = head.match(vocativeBefore);
  if (vocativeBeforeMatch && isPlausibleName(vocativeBeforeMatch[1])) {
    return {
      name: cleanName(vocativeBeforeMatch[1]),
      pronoun: null,
      raw: vocativeBeforeMatch[0].trim(),
      end: quoteStart,
      side: "before"
    };
  }

  const beforeTag = new RegExp(
    `(${NAME})\\s+(?:\\p{Ll}+\\s+){0,2}(?:${VERB_ALT})\\s*[.,:—–-]?\\s*$`,
    "u",
  );
  const beforeMatch = head.match(beforeTag);
  if (beforeMatch && isPlausibleName(beforeMatch[1])) {
    return {
      name: cleanName(beforeMatch[1]),
      pronoun: null,
      raw: beforeMatch[0].trim(),
      end: quoteStart,
      side: "before"
    };
  }

  // "…, she said." with no name — the pronoun still marks it as a tag.
  const pronounBefore = new RegExp(`\\s*(?:(he|she|they)\\s+)?(?:${VERB_ALT})\\s*\\.?\\s*$`, "u");
  const pronounBeforeMatch = head.match(pronounBefore);
  if (pronounBeforeMatch && pronounBeforeMatch[0].trim().length > 0) {
    return {
      name: null,
      pronoun: pronounBeforeMatch[1] ?? null,
      raw: pronounBeforeMatch[0].trim(),
      end: quoteStart,
      side: "before"
    };
  }

  // --- after the quote ---
  const vocativeAfter = new RegExp(
    `^\\s*[,—–-]?\\s*(${NAME})\\s*,\\s*(?:he|she|they)\\s+(?:${VERB_ALT})\\b`,
    "u",
  );
  const vocativeAfterMatch = tail.match(vocativeAfter);
  if (vocativeAfterMatch && isPlausibleName(vocativeAfterMatch[1])) {
    return {
      name: cleanName(vocativeAfterMatch[1]),
      pronoun: null,
      raw: vocativeAfterMatch[0].trim(),
      end: quoteEnd + vocativeAfterMatch[0].length,
      side: "after",
    };
  }

  const afterTag = new RegExp(
    `^\\s*[,—–-]?\\s*(${NAME})\\s+(?:\\p{Ll}+\\s+){0,2}(?:${VERB_ALT})\\b`,
    "u",
  );
  const afterMatch = tail.match(afterTag);
  if (afterMatch && isPlausibleName(afterMatch[1])) {
    return {
      name: cleanName(afterMatch[1]),
      pronoun: null,
      raw: afterMatch[0].trim(),
      end: quoteEnd + afterMatch[0].length,
      side: "after",
    };
  }

  const pronounAfter = new RegExp(
    `^\\s*[,—–-]?\\s*(?:(he|she|they)\\s+)?(?:${VERB_ALT})\\b`,
    "u",
  );
  const pronounAfterMatch = tail.match(pronounAfter);
  if (pronounAfterMatch && pronounAfterMatch[0].trim().length > 0) {
    return {
      name: null,
      pronoun: pronounAfterMatch[1] ?? null,
      raw: pronounAfterMatch[0].trim(),
      end: quoteEnd + pronounAfterMatch[0].length,
      side: "after",
    };
  }

  return null;
}

/** A short narration beat between two dialogue lines. */
interface Beat {
  name: string | null;
  pronoun: string | null;
  raw: string;
}

function findBeat(text: string): Beat | null {
  const clean = text
    .replace(/^\s*[,—–-]+\s*/, "")
    .replace(/\s+$/, "")
    .trim();
  if (clean.length === 0) return null;
  if (clean.split(/\s+/).length > 16) return null;

  // A speech verb is a tag, not an action beat, so a gap made of nothing but
  // `Sarah said.` and punctuation is left over from the previous line's tag.
  // Reading it as a beat would hand this line's speaker to whoever spoke last,
  // which is how an unattributed line silently inherits a name.
  if (new RegExp(`^(?:${NAME}\\s+)?(?:(?:\\p{Ll}+\\s+){0,2})(?:${VERB_ALT})\\s*[.,:;!—"“”]?\\s*$`, "u").test(clean)) {
    return null;
  }

  // A beat that is only an action still belongs to the character it describes,
  // so the name is read from it, but a lone pronoun is not resolvable here.
  const nameMatch = clean.match(new RegExp(NAME, "u"));
  if (nameMatch && isPlausibleName(nameMatch[0])) {
    return { name: cleanName(nameMatch[0]), pronoun: null, raw: clean };
  }

  const pronoun = clean
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}]/gu, "").toLowerCase())
    .find((word) => PRONOUNS.has(word));

  if (pronoun) return { name: null, pronoun, raw: clean };

  return null;
}

function push(
  suggestions: Suggestion[],
  title: string,
  original: string,
  note: string,
): void {
  suggestions.push({
    id: `p${suggestions.length + 1}`,
    category: "pov",
    title,
    original,
    suggestion: "",
    note,
  });
}

export interface PovResult {
  speakers: SpeakerNote[];
  suggestions: Suggestion[];
}

/**
 * Resolves a speaker for every quoted line and reports what it found.
 *
 * `enforce` additionally proposes a rewrite for the case where the correct
 * speaker is provable: a redundant tag on a speaker who has just spoken.
 */
export function analysePov(text: string, mode: PovMode = "detect"): PovResult {
  const speakers: SpeakerNote[] = [];
  const suggestions: Suggestion[] = [];

  if (mode === "off") return { speakers, suggestions };

  const blocks = extractDialogue(text);
  if (blocks.length === 0) return { speakers, suggestions };

  /** Speaker carried forward from the previous line of the same exchange. */
  let carried: string | null = null;
  let lastSpokeName: string | null = null;
  let lastSpokeIndex = -1;
  let untaggedRun = 0;

  blocks.forEach((block, position) => {
    const previous = position > 0 ? blocks[position - 1] : null;

    // Narration between the previous quote and this one, which may cross a
    // paragraph break — that gap is exactly where a beat usually sits.
    const between = previous ? text.slice(previous.end, block.start) : "";

    const after = text.slice(block.end, Math.min(text.length, block.end + 90));
    // A tag placed before the opening quote is read from the gap since the
    // previous line closed, never further back. Reaching further would borrow the
    // previous line's own trailing tag, and the line would then look like it had
    // an attribution of its own when the tag actually belongs to its neighbour.
    const beforeFrom = previous
      ? Math.max(previous.end, block.start - 90)
      : Math.max(0, block.start - 90);
    const before = text.slice(beforeFrom, block.start);

    const tag = findAttribution(before, after, block.start, block.end);
    const betweenBeat = findBeat(between);
    // A tag on the line outranks a beat, which outranks trailing narration.
    // The trailing scan stops at the next quote, so a line with no narration of
    // its own cannot borrow the opening of the line that follows.
    const nextQuote = after.search(/["']/);
    const trailingBeat = findBeat(
      (nextQuote >= 0 ? after.slice(0, nextQuote) : after).replace(/^\s*[,—–-]+/, ""),
    );
    const beat = betweenBeat ?? trailingBeat;
    const adjacent = Boolean(previous && block.paragraph - previous.paragraph <= 1);
    // True when the attribution sits on this line rather than ahead of it. A
    // trailing tag begins in the gap after the closing quote, so its end always
    // reaches past `block.end`; a tag sitting before the opening quote does not.
    const ownsTag = Boolean(tag && tag.end > block.end);

    const note: SpeakerNote = {
      index: block.index,
      speaker: null,
      line: block.line,
      basis: "ambiguous",
    };

    // Resolve in order of confidence: a named tag, then a named beat, then a
    // carried-forward speaker, then a pronoun tag resolved to a nearby name.
    if (tag?.name) {
      note.speaker = tag.name;
      note.basis = "tag";
      untaggedRun = 0;
    } else if (beat?.name) {
      note.speaker = beat.name;
      note.basis = "beat";
      untaggedRun = 0;
    } else if (carried && adjacent) {
      note.speaker = carried;
      note.basis = "carried";
      untaggedRun += 1;
    } else if (tag?.pronoun) {
      // A pronoun tag is unremarkable when the character was just named, as in
      // `Sarah closed the book. "I should go," she said.`
      const nearby = lastNameBefore(text, block.start);
      const resolvable = nearby && namedJustBefore(text, nearby, block.start) ? nearby : null;

      if (resolvable) {
        note.speaker = resolvable;
        note.basis = "tag";
        untaggedRun = 0;
      } else {
        note.speaker = nearby;
        untaggedRun += 1;
        push(
          suggestions,
          "Speaker identified only by pronoun",
          tag.raw,
          `The tag is "${tag.pronoun}" rather than a name, so the reader has to remember who ${tag.pronoun} is${
            nearby ? ` — probably ${nearby}, from earlier in the passage` : ", and nothing earlier establishes it"
          }. Naming the character reads more clearly.`,
        );
      }
    } else {
      untaggedRun += 1;
    }

    // A tag that names someone other than the character described by the beat
    // immediately after it. One of the two attributions is wrong. The beat has
    // to follow the tag; a beat before it is a character speaking, and a tag
    // ahead of the quote belongs to the next turn.
    if (tag?.name && ownsTag && trailingBeat?.name && tag.name !== trailingBeat.name) {
      note.contradictedBy = trailingBeat.name;
      push(
        suggestions,
        "Tag contradicts the following beat",
        tag.raw,
        `This line is tagged as ${tag.name}, but the narration right after it is ${trailingBeat.name}'s (${trailingBeat.raw}). One of the two attributions is wrong.`,
      );
    }

    // A beat that reaches for a pronoun instead of a name. A pronoun inside a
    // dialogue tag is normal English and is never reported.
    if (betweenBeat?.pronoun && !tag?.name) {
      push(
        suggestions,
        "Beat uses a pronoun instead of a name",
        betweenBeat.raw,
        `"${betweenBeat.pronoun}" does not say which character this beat belongs to. Use the character's name so the speaker of the next line is unambiguous.`,
      );
    }

    // The translated-webnovel signature: the same character named again on the
    // line right after they spoke. A tag this line merely inherited from the
    // previous one is not a repeat, because the window above stops at the
    // previous line's closing quote, so an inherited tag never reaches this
    // test. The first tag in an exchange is kept, because the reader needs one
    // anchor to know who is talking.
    const repeatsSameSpeaker =
      Boolean(tag?.name) &&
      ownsTag &&
      lastSpokeName === tag?.name &&
      lastSpokeIndex === position - 1;

    if (repeatsSameSpeaker) {
      if (mode === "enforce") {
        // `after` is the text from this line's closing quote onward, so the tag
        // starts at `block.end` plus whatever separated the two.
        const lead = tag.end - block.end - tag.raw.length;
        const at = block.end + Math.max(0, lead);
        const tail = after.slice(lead + tag.raw.length);

        // The tag carries the sentence's punctuation after it, so once the tag is
        // gone the line needs an ending of its own: `…," Minjun said.` becomes
        // `…."` rather than keeping a comma with nothing after it, and a line that
        // already ended `."` must not gain a second full stop.
        const quoteEndsSentence = /[.!?]["”’)\]]?\s*$/u.test(block.quote);
        const marks = quoteEndsSentence ? "" : (tail.match(/^[\s]*[.!?]+/u)?.[0] ?? "");

        // A line that ran into its tag is rewritten from the mark nearest the
        // closing quote, so `"No, you're not," Minjun said.` becomes
        // `"No, you're not."` rather than keeping a comma outside the quotation.
        const markAt = quoteEndsSentence ? -1 : trailingMarkStart(block.quote.slice(0, -1));
        // The mark sits inside the line, so the span starts there and stops at
        // the tag. The closing quotation mark is put back by the replacement.
        const tagStart = markAt >= 0 ? block.start + markAt : at - countLeadingPunctuation(after.slice(Math.max(0, lead)));
        // The tag's own sentence punctuation is part of the span when the line
        // already ended in a full stop, so removing the tag does not strand the stop.
        const own = tail.match(/^\s*[.!?]+/u)?.[0] ?? "";
        const length = at + tag.raw.length + (marks.length || own.length) - tagStart;
        // When the span began inside the line it swallowed the closing
        // quotation mark, so the replacement puts it back after the new full stop.
        const replacement =
          (quoteEndsSentence ? "" : marks.trim()) + (markAt >= 0 ? block.quote.slice(-1) : "");

        note.fix = {
          original: text.slice(tagStart, tagStart + length),
          suggestion: replacement,
          title: "Drop the repeated speaker name",
          note: `${tag.name} spoke the previous line, so the tag repeats what the reader already knows.`,
          at: tagStart,
          length,
          replacement,
        };
        push(
          suggestions,
          "Drop the repeated speaker name",
          tag.raw,
          `${tag.name} is named again immediately after speaking. Translated Korean webnovel prose tags nearly every line; dropping the repeat reads more naturally in English.`,
        );
      } else {
        push(
          suggestions,
          "Speaker name repeated on every line",
          tag.raw,
          `${tag.name} is tagged again straight after speaking. The reader can infer the speaker, so the repeat is optional.`,
        );
      }
    }

    // Three or more lines in a row with nothing to identify the speaker.
    if (untaggedRun >= 3) {
      push(
        suggestions,
        "Long run of unattributed dialogue",
        block.quote,
        `${untaggedRun} lines in a row carry no name or tag. If more than one character is talking, the reader has no way to follow who has the floor.`,
      );
    }

    if (note.speaker) {
      carried = note.speaker;
      lastSpokeName = note.speaker;
      lastSpokeIndex = position;
    }

    speakers.push(note);
  });

  return { speakers, suggestions };
}

/**
 * Applies the proposed tag removals.
 *
 * The span is removed by offset rather than by regex so a tag sitting at the end
 * of a paragraph takes its line break with it and the dialogue lines stay
 * separate.
 */
/**
 * Measures the gap between a line's closing quote and the tag that follows it.
 *
 * A tag removed on its own leaves the space and the comma that introduced it, so
 * `"I'm fine," Minjun said.` would keep a comma with nothing after it.
 */
function countLeadingPunctuation(before: string): number {
  return before.match(/^[\s]*[,—–-]+[\s]*/u)?.[0].length ?? 0;
}

export function applyPovFixes(text: string, speakers: SpeakerNote[]): string {
  const edits = speakers
    .map((note) => {
      const fix = note.fix;
      if (!fix || fix.at === undefined || fix.length === undefined) return null;
      // The recorded offset is the span to change, but a re-analysis against
      // edited text can leave it stale, so it is checked against the source
      // before anything is touched.
      if (text.slice(fix.at, fix.at + fix.length) !== fix.original) return null;
      return { at: fix.at, length: fix.length, replacement: fix.replacement ?? "" };
    })
    .filter((value): value is { at: number; length: number; replacement: string } => value !== null)
    .sort((a, b) => a.at - b.at);

  if (edits.length === 0) return text;

  let result = "";
  let cursor = 0;

  for (const edit of edits) {
    result += text.slice(cursor, edit.at) + edit.replacement;
    cursor = edit.at + edit.length;
  }

  result += text.slice(cursor);

  return result
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/[ \t]+([,.;:!?])/g, "$1");
}
