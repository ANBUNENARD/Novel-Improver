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

/** Same as slug(), but keeps the last token, which is how "Lee Soo-hyun" matches "Soo-hyun". */
function looseKey(value: string): string {
  const words = slug(value).split(" ").filter(Boolean);
  return words.length > 1 ? words[words.length - 1] : words[0] ?? "";
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
  loose: string;
}

function buildIndex(bible: StoryBible | undefined): MatchIndex[] {
  const index: MatchIndex[] = [];

  for (const entry of bible?.entries ?? []) {
    for (const surface of [entry.name, ...entry.aliases]) {
      const key = slug(surface);
      if (!key || key.length < 2) continue;
      index.push({ entry, surface, key, loose: looseKey(surface) });
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

/**
 * Finds every alias the chapter used for a bible entry.
 *
 * Exact matches are reported with their own surface. A short alias that only
 * matches as a trailing token ("Soo-hyun" inside "Lee Soo-hyun") is reported
 * as the same entry, so the reader sees one character rather than two.
 */
export function findContinuityNotes(
  text: string,
  bible: StoryBible | undefined,
): ContinuityNote[] {
  if (!text.trim()) return [];

  const haystack = text.toLowerCase();
  const index = buildIndex(bible);
  const notes: ContinuityNote[] = [];
  const seen = new Set<string>();

  for (const candidate of index) {
    if (seen.has(candidate.entry.id)) continue;
    if (isCommonWord(candidate.key)) continue;

    let at = haystack.indexOf(candidate.key);
    if (at === -1 && candidate.loose.length >= 3 && candidate.loose !== candidate.key) {
      at = haystack.search(new RegExp(`\\b${escapeRegExp(candidate.loose)}\\b`));
    }
    if (at === -1) continue;

    seen.add(candidate.entry.id);
    const surface = text.slice(at, at + candidate.surface.length);
    const exact = surface.toLowerCase() === candidate.key;

    notes.push({
      raw: surface,
      canonical: candidate.entry.name,
      ...(exact ? {} : { via: candidate.surface }),
      context: contextAround(text, at, candidate.surface.length),
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
  if (!text.trim()) return { text, notes: [] };

  const notes: ContinuityNote[] = [];
  const index = buildIndex(bible);
  let result = text;

  for (const candidate of index) {
    if (isCommonWord(candidate.key)) continue;
    const canonical = candidate.entry.name;
    if (slug(candidate.surface) === slug(canonical)) continue;

    // A full name inside another full name ("Lee Soo-hyun" inside "Mardol Lee
    // Soo-hyun") is already correct; only the differing part needs a swap.
    const pattern = new RegExp(`\\b${escapeRegExp(candidate.key)}\\b`, "gi");
    if (!pattern.test(result)) continue;

    const shouting = result === result.toUpperCase() && /[A-Z]/.test(result);
    result = result.replace(pattern, () => (shouting ? canonical.toUpperCase() : canonical));

    notes.push({
      raw: candidate.surface,
      canonical,
      via: candidate.surface,
      context: contextAround(text, text.toLowerCase().indexOf(candidate.key), candidate.surface.length),
      note: describeEntry(candidate.entry),
    });
  }

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
export const internal = { slug, looseKey, guessKind, splitList, readGender };
