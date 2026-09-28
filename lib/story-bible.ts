/**
 * The continuity / story-bible layer.
 *
 * A long novel polishes far better when established facts travel with the
 * chapter instead of living in the editor's head. This module holds that
 * dictionary, resolves the machine-translation variants of a name against it,
 * and renders it into the block the model reads before it starts editing.
 *
 * It is pure and free of `server-only` so the same code runs in the browser
 * (where the dictionary is edited and kept) and on the server (where the
 * normaliser runs before the model is called).
 */

import type { BibleEntry, BibleEntryKind, ContinuityNote, Gender, StoryBible } from "./types";
import { BIBLE_ENTRY_KINDS } from "./types";

/** Refuse dictionaries that would bloat every request past the model's limit. */
export const MAX_BIBLE_ENTRIES = 200;

const GENDERS: Record<string, Gender> = {
  male: "male",
  man: "male",
  m: "male",
  he: "male",
  him: "male",
  his: "male",
  female: "female",
  woman: "female",
  f: "female",
  she: "female",
  her: "female",
  nonbinary: "other",
  "non binary": "other",
  other: "other",
};

function slug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Matches a name whose separators the slug has flattened.
 *
 * `slug` turns "Lee Soo-hyun" into "lee soo hyun", so a plain search for the
 * slug misses the name in the text even though the reader wrote it. Each space
 * becomes "one or more of any separator a name may carry", which matches the
 * spelling, the hyphenated spelling, and the apostrophised one alike.
 */
function flexibleName(value: string): RegExp {
  const words = slug(value).split(" ").filter(Boolean);
  if (words.length === 0) return /(?!)/;
  return new RegExp(`\\b${words.map(escapeRegExp).join("[\\s\\u2010-\\u2015'\\u2019-]+")}\\b`, "i");
}

/**
 * Matches the name backwards from one of its words, for a chapter that dropped
 * or reordered part of it.
 *
 * A name is matched on the token it is most recognisable by, then widened to
 * whatever else of the name sits before it: "Soo-hyun" for a chapter that wrote
 * "Lee Soo-hyun", or the reverse. The token is a whole word, so a match can
 * never begin in the middle of one.
 */
function trailingToken(value: string): RegExp {
  const text = trailingTokenText(value);
  return text ? new RegExp(`\\b${escapeRegExp(text)}\\b`, "i") : /(?!)/;
}

/** The last whole word of a name, which is what a shortened spelling keeps. */
function trailingTokenText(value: string): string {
  const words = slug(value).split(" ").filter(Boolean);
  return words[words.length - 1] ?? "";
}

function readGender(value: unknown): Gender | undefined {
  if (typeof value !== "string") return undefined;
  return GENDERS[slug(value)];
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function splitList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(readString).filter(Boolean);
  }

  const raw = readString(value);
  if (!raw) return [];

  return raw
    .split(/[,;/|]|\band\b/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

let counter = 0;

function makeId(): string {
  counter += 1;
  return `b${counter}`;
}

function isValidEntry(value: unknown): value is Partial<BibleEntry> {
  return value !== null && typeof value === "object" && readString((value as { name?: unknown }).name) !== "";
}

/** Coerces anything shaped like an entry into a clean one, or returns null. */
export function normaliseEntry(value: unknown): BibleEntry | null {
  if (!isValidEntry(value)) return null;

  const raw = value as Partial<BibleEntry>;
  const name = readString(raw.name);
  if (!name) return null;

  const kindInput = readString(raw.kind).toLowerCase();
  const kind = (BIBLE_ENTRY_KINDS as string[]).includes(kindInput)
    ? (kindInput as BibleEntryKind)
    : guessKind(name, readString(raw.role));

  const aliases = splitList(raw.aliases).filter((alias) => slug(alias) !== slug(name));
  const gender = readGender(raw.gender);
  const role = readString(raw.role);
  const notes = readString(raw.notes);

  return {
    id: readString(raw.id) || makeId(),
    kind,
    name,
    aliases,
    ...(gender ? { gender } : {}),
    ...(role ? { role } : {}),
    ...(notes ? { notes } : {}),
  };
}

/** House, temple, guild, cult, and the like read as locations unless told otherwise. */
function guessKind(name: string, role: string): BibleEntryKind {
  if (
    /\b(temple|church|city|town|fort|academy|school|tower|ruins|palace|forest|mountain|street|land|kingdom|island)\b/i.test(
      name,
    )
  ) {
    return "location";
  }
  if (/\b(guild|order|cult|company|association|house|cabinet|clan|legion)\b/i.test(role)) {
    return "organisation";
  }
  return "character";
}

/** Keeps a pasted or edited dictionary inside the limits the prompt can carry. */
export function normaliseBible(value: unknown): StoryBible {
  const rawEntries = Array.isArray(value)
    ? value
    : Array.isArray((value as { entries?: unknown })?.entries)
      ? ((value as { entries: unknown[] }).entries)
      : [];

  const entries: BibleEntry[] = [];
  for (const candidate of rawEntries.slice(0, MAX_BIBLE_ENTRIES)) {
    const entry = normaliseEntry(candidate);
    if (entry) entries.push(entry);
  }

  return { entries };
}

/** How many names the dictionary will contribute to the prompt. */
export function bibleNameCount(bible: StoryBible | undefined): number {
  return (bible?.entries ?? []).reduce((total, entry) => total + 1 + entry.aliases.length, 0);
}

interface MatchIndex {
  entry: BibleEntry;
  /** Alias, spelled as it may appear in the text. */
  surface: string;
  key: string;
  /** Matches the name across any separator a name may carry. */
  flexible: RegExp;
  /** Matches the name on its last whole word alone. */
  token: RegExp;
  tokenText: string;
}

function buildIndex(bible: StoryBible | undefined): MatchIndex[] {
  const index: MatchIndex[] = [];

  for (const entry of bible?.entries ?? []) {
    for (const surface of [entry.name, ...entry.aliases]) {
      const key = slug(surface);
      if (!key || key.length < 2) continue;
      index.push({
        entry,
        surface,
        key,
        flexible: flexibleName(surface),
        token: trailingToken(surface),
        tokenText: trailingTokenText(surface),
      });
    }
  }

  // Longest first, so "Phine Grancia" is preferred over the bare "Grancia".
  return index.sort((a, b) => b.surface.length - a.surface.length);
}

/** True when the match is an ordinary English word rather than a name. */
function isCommonWord(key: string): boolean {
  return COMMON_WORDS.has(key);
}

const COMMON_WORDS = new Set([
  "the", "a", "an", "he", "she", "it", "they", "we", "you", "i", "fine", "man", "woman",
  "girl", "boy", "king", "queen", "sir", "lord", "lady", "master", "miss", "saint",
  "father", "mother", "brother", "sister", "son", "daughter", "old", "young",
  "light", "dark", "sun", "moon", "star", "iron", "gold", "silver", "stone",
  "blood", "soul", "heart", "mind", "hand", "eye", "word", "name", "book",
  "read", "novel", "chapter", "free", "next", "previous", "first", "one",
]);

/** Characters that end a sentence, including the closing half of a quote pair. */
const SENTENCE_END = /[.!?]["\u201D\u2019)]?/;

/**
 * The sentence around an index, trimmed, for showing a match in context.
 *
 * The scan starts at the first opener after the previous sentence end and stops
 * at the first terminator after the match, so a name inside a quotation shows
 * the whole quotation rather than a fragment that starts mid-sentence.
 */
function contextAround(text: string, at: number, length: number): string {
  let start = 0;

  for (const opener of ["\n", ". ", "! ", "? ", '"', "\u201C"]) {
    const found = text.lastIndexOf(opener, at);
    if (found !== -1 && found + opener.length > start) start = found + opener.length;
  }

  let end = text.length;
  const tail = text.slice(at + length);
  const stop = tail.search(SENTENCE_END);
  if (stop !== -1) end = at + length + stop + 1;

  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

/** Where a name was found in the reader's text, and what it was written as. */
interface NameHit {
  at: number;
  surface: string;
}

/**
 * Locates a dictionary name in the text.
 *
 * The name is matched as written, across any separator the slug flattened, so
 * a spelling the reader chose is still found. A short form that only survives
 * as the last word of the name ("Soo-hyun" for "Lee Soo-hyun") is then matched
 * on that word alone, and the span is widened back over whatever else of the
 * name sits before it.
 */
function locate(text: string, candidate: MatchIndex): NameHit | null {
  const whole = text.match(candidate.flexible);
  if (whole?.index !== undefined) {
    return { at: whole.index, surface: whole[0] };
  }

  if (candidate.tokenText.length < 3 || candidate.tokenText === candidate.key) return null;

  const token = text.search(candidate.token);
  if (token === -1) return null;

  // A longer name only claims a trailing word when the reader wrote something
  // of that name there. Where the chapter has "Soo-hyun" and the dictionary
  // holds "Lee Soo-hyun", the words before the hit are absent, so this is the
  // alias's own spelling and the full name has nothing to report.
  const at = token - (candidate.surface.length - candidate.tokenText.length);
  if (at < 0 || text.slice(at, token).toLowerCase() !== candidate.key.slice(0, at)) return null;

  return { at, surface: text.slice(at, token + candidate.tokenText.length) };
}

/**
 * Finds every alias the chapter used for a bible entry.
 *
 * Each dictionary surface is looked for in the text and reported with the span
 * the match actually covers. The index is ordered longest name first, so a full
 * name claims its span before a shorter alias that ends inside it, and the
 * reader is told which character the spelling belongs to.
 */
export function findContinuityNotes(
  text: string,
  bible: StoryBible | undefined,
): ContinuityNote[] {
  if (!text.trim()) return [];

  const index = buildIndex(bible);
  const notes: ContinuityNote[] = [];
  const taken: Array<[number, number]> = [];
  const seen = new Set<string>();

  for (const candidate of index) {
    if (seen.has(candidate.entry.id)) continue;
    if (isCommonWord(candidate.key)) continue;

    const hit = locate(text, candidate);
    if (!hit) continue;
    if (taken.some(([from, to]) => hit.at < to && hit.at + hit.surface.length > from)) continue;

    taken.push([hit.at, hit.at + hit.surface.length]);
    seen.add(candidate.entry.id);

    notes.push({
      raw: hit.surface,
      canonical: candidate.entry.name,
      ...(slug(hit.surface) === candidate.key ? {} : { via: candidate.surface }),
      context: contextAround(text, hit.at, hit.surface.length),
      note: describeEntry(candidate.entry),
    });
  }

  return notes;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function describeEntry(entry: BibleEntry): string {
  const parts: string[] = [];
  if (entry.gender) parts.push(entry.gender);
  if (entry.role) parts.push(entry.role);
  const tail = parts.join(", ");
  // The name is already on the row, so a note that adds no detail is left empty
  // rather than repeating it back at the reader.
  return tail ? `${entry.name} (${tail})` : "";
}

/**
 * Rewrites known alias spellings to their canonical form.
 *
 * This runs before the model so the whole dictionary is already in one
 * spelling by the time it reads the chapter, and it is reported as a
 * continuation note so the change is never silent.
 */
export function normaliseNames(
  text: string,
  bible: StoryBible | undefined,
): { text: string; notes: ContinuityNote[] } {
  if (!text.trim()) return { text: text, notes: [] };

  const notes: ContinuityNote[] = [];
  const index = buildIndex(bible);
  const shouted = text === text.toUpperCase() && /[A-Z]/.test(text);

  // Every span a dictionary name occupies in the reader's text, longest name
  // first. Working from spans rather than from search-and-replace keeps an
  // alias from matching inside the canonical spelling it belongs to, which
  // would turn "Lee Soo-hyun" into "Lee Lee Soo-hyun". The spans already
  // written in canonical form are reserved before any alias is considered, so
  // an alias can only take a place where the reader used the short form.
  const taken: Array<[number, number]> = [];
  const spans: Array<{ at: number; length: number; canonical: string; surface: string; entry: BibleEntry }> = [];

  for (const candidate of index) {
    const settled = text.match(flexibleName(candidate.entry.name));
    if (settled?.index !== undefined) taken.push([settled.index, settled.index + settled[0].length]);
  }

  for (const candidate of index) {
    if (isCommonWord(candidate.key)) continue;
    const canonical = candidate.entry.name;
    if (slug(candidate.surface) === slug(canonical)) continue;

    const hit = locate(text, candidate);
    if (!hit) continue;
    if (taken.some(([from, to]) => hit.at < to && hit.at + hit.surface.length > from)) continue;

    taken.push([hit.at, hit.at + hit.surface.length]);
    spans.push({
      at: hit.at,
      length: hit.surface.length,
      canonical,
      surface: hit.surface,
      entry: candidate.entry,
    });
  }

  if (spans.length === 0) return { text, notes: [] };

  let result = "";
  let cursor = 0;
  for (const span of [...spans].sort((a, b) => a.at - b.at)) {
    const replacement = shouted ? span.canonical.toUpperCase() : span.canonical;

    // A name is often written with the article the dictionary leaves off, as in
    // "the Temple" for "Temple of Tarden". The article belongs to the sentence
    // rather than the name, so it is carried across to keep the line readable.
    const article = span.surface.match(/^(the|a|an)\s+/i)?.[0] ?? "";
    const keep = article && !/^(the|a|an)\s/i.test(replacement) ? article : "";

    result += text.slice(cursor, span.at) + keep + replacement;
    cursor = span.at + span.length;

    notes.push({
      raw: span.surface,
      canonical: span.canonical,
      via: span.surface,
      context: contextAround(text, span.at, span.length),
      note: describeEntry(span.entry),
    });
  }
  result += text.slice(cursor);

  return { text: result, notes };
}

/**
 * Renders the dictionary as the block appended to the request prompt.
 *
 * Grouped by kind and sorted by name so the model reads the same shape every
 * time; an empty bible returns an empty string rather than a bare heading.
 */
export function formatBibleForPrompt(bible: StoryBible | undefined): string {
  const entries = (bible?.entries ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
  if (entries.length === 0) return "";

  const headings: Array<{ kind: BibleEntryKind; title: string }> = [
    { kind: "character", title: "CHARACTERS" },
    { kind: "location", title: "LOCATIONS" },
    { kind: "organisation", title: "ORGANISATIONS" },
    { kind: "term", title: "TERMS AND SYSTEMS" },
  ];

  const lines: string[] = ["STORY CONTINUITY DICTIONARY (authoritative for this chapter):"];

  for (const heading of headings) {
    const group = entries.filter((entry) => entry.kind === heading.kind);
    if (group.length === 0) continue;

    lines.push("", `${heading.title}:`);
    for (const entry of group) {
      const parts = [`- ${entry.name}`];
      if (entry.gender) parts.push(`(${entry.gender})`);
      if (entry.aliases.length > 0) parts.push(`= ${entry.aliases.join(" = ")}`);
      if (entry.role) parts.push(`| ${entry.role}`);
      if (entry.notes) parts.push(`| ${entry.notes}`);
      lines.push(parts.join(" "));
    }
  }

  return lines.join("\n");
}

/** The parser, the dictionary, and the normaliser, for the test harness. */
export const internal = { slug, trailingTokenText, guessKind, splitList, readGender };
