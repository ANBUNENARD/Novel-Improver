/**
 * The shipped story bible and the parser that fills it in from pasted text.
 *
 * The default is the dictionary from the workflow document, so the panel is
 * populated the moment a new novel project is opened. `parseBibleText` reads
 * the same format back, which means a dictionary can be typed by hand, pasted
 * from the document, or edited in the panel and round-tripped through storage.
 */

import type { BibleEntry, BibleEntryKind, StoryBible } from "./types";
import { normaliseBible, normaliseEntry } from "./story-bible";

interface Seed {
  kind: BibleEntryKind;
  name: string;
  aliases?: string[];
  gender?: "male" | "female" | "other";
  role?: string;
}

/** The project dictionary, ordered as the document lists it. */
const SEED: Seed[] = [
  {
    kind: "character",
    name: "Licht",
    gender: "male",
    role: "first-person protagonist; real name Lee Soo-hyun; Pure Black Knight; Hero of Conviction",
  },
  {
    kind: "character",
    name: "Phine",
    aliases: ["Phine Grancia", "Mardol"],
    gender: "female",
    role: "Glass Knight; Nameless Saintess on the relevant alternate routes",
  },
  { kind: "character", name: "Chartiness", gender: "female", role: "Second Saintess; vampire" },
  { kind: "character", name: "Kainel", gender: "male", role: "Hero; Ariel's childhood friend and love interest" },
  { kind: "character", name: "Ariel", gender: "female", role: "red-haired elf mage" },
  {
    kind: "character",
    name: "Nex",
    gender: "male",
    role: "purple-haired spirit user; descendant of Asha Aureus",
  },
  { kind: "character", name: "Asha Aureus", gender: "female", role: "Living Sun; Duke of House Aureus" },
  { kind: "character", name: "Laplace", gender: "male", role: "Great Magician; Academy president" },
  { kind: "character", name: "Head Acher", role: "Demon King of Omniscience" },
  { kind: "term", name: "Giyu", role: "Licht's personal sword" },
  { kind: "location", name: "Temple of Tarden" },
  { kind: "location", name: "Library of Truth" },
  { kind: "organisation", name: "Heroic Cult" },
];

function seedEntries(): BibleEntry[] {
  return SEED.map((seed, index) =>
    normaliseEntry({
      id: `seed${index + 1}`,
      kind: seed.kind,
      name: seed.name,
      aliases: seed.aliases ?? [],
      gender: seed.gender,
      role: seed.role,
    })!,
  );
}

let cached: StoryBible | null = null;

/** The shipped dictionary. Built once and returned by reference. */
export function defaultBible(): StoryBible {
  if (cached === null) {
    cached = { entries: seedEntries() };
  }
  return cached;
}

/** Local-storage key the editor keeps a project's own cast under. */
export const BIBLE_STORAGE_KEY = "proselens:story-bible:v1";

/**
 * The dictionary saved in this browser, or the shipped one.
 *
 * The panel that used to edit this dictionary is gone, so the entries are only
 * ever read here. Anything unreadable falls back to the shipped cast, which is
 * the behaviour the editor had before a project overwrote it.
 */
export function readStoredBible(): StoryBible {
  if (typeof window === "undefined") return defaultBible();

  try {
    const raw = window.localStorage.getItem(BIBLE_STORAGE_KEY);
    if (!raw) return defaultBible();
    const parsed = normaliseBible(JSON.parse(raw));
    return parsed.entries.length > 0 ? parsed : defaultBible();
  } catch {
    return defaultBible();
  }
}

function list(value: string): string[] {
  return value
    .split(/[;,/|]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Strips a leading bullet, a heading underline, or a trailing colon. */
function cleanName(value: string): string {
  return value
    .replace(/^[\s\-*\u2022\u2013\u2014#]+/, "")
    .replace(/[:\s]+$/, "")
    .trim();
}

function kindFromHeading(heading: string): BibleEntryKind {
  if (/character|people|cast/i.test(heading)) return "character";
  if (/location|place|setting/i.test(heading)) return "location";
  if (/organis|organization|faction|guild|cult|order/i.test(heading)) return "organisation";
  return "term";
}

const GENDER_TOKEN = /^(male|female|woman|man|non-?binary|girl|boy)\b\s*[;,]?\s*/i;

/**
 * Rejects a line that reads as prose rather than as a dictionary entry.
 *
 * Three cheap signals, chosen so a terse real entry survives: a name is never a
 * long clause, a multi-word name is capitalised, and a descriptive field that
 * runs on for several words and ends in a full stop is a sentence.
 */
function readsLikeAProseLine(name: string, detail: string): boolean {
  const nameWords = name.split(/\s+/).filter(Boolean);
  if (nameWords.length > 5) return true;
  if (nameWords.length > 1 && !/^[A-Z]/.test(name)) return true;

  const detailWords = detail.split(/\s+/).filter(Boolean);
  return detailWords.length > 3 && /[.!?]$/.test(detail.trim());
}

function parseEntry(line: string, kind: BibleEntryKind): BibleEntry | null {
  // "Phine: female = Phine Grancia = Mardol; Glass Knight" splits into the name
  // and everything that describes it. The detail is split again on the
  // separators below, so a colon is the only thing that ends the name.
  const colon = line.indexOf(":");
  const head = colon === -1 ? line : line.slice(0, colon);
  const detail = colon === -1 ? "" : line.slice(colon + 1);

  const [pipeParts, ...rest] = detail.split("|").map((part) => part.trim());
  const parts = (rest.length > 0 ? rest.join("|") : pipeParts)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);

  let name = cleanName(head.replace(/\([^)]*\)/g, ""));
  let gender: string | undefined;

  // A leading "(female)" is the gender; anything after it stays in the name.
  const genderMatch = head.match(/\(\s*([a-z-]+)\s*\)/i);
  if (genderMatch) {
    gender = genderMatch[1];
    const leftover = cleanName(head.replace(genderMatch[0], ""));
    if (leftover) name = leftover;
  }

  if (!name) return null;
  if (readsLikeAProseLine(name, detail)) return null;

  const aliases: string[] = [];
  const roles: string[] = [];

  for (const raw of parts) {
    // A gender can lead the detail too, as in "Kainel: male; Hero".
    let part = raw;
    const token = part.match(GENDER_TOKEN);
    if (token && gender === undefined) {
      gender = token[1];
      part = part.slice(token[0].length);
    }
    if (!part) continue;

    if (part.includes("=")) {
      aliases.push(...list(part.replace(/=/g, ",")).map(cleanName).filter(Boolean));
    } else if (/^alias(es)?\b|also\b|aka\b/i.test(part)) {
      aliases.push(...list(part.replace(/^[^:]*:\s*/i, "")));
    } else if (/^role\b|^title\b/i.test(part)) {
      roles.push(part.replace(/^[^:]*:\s*/i, ""));
    } else {
      roles.push(part);
    }
  }

  return normaliseEntry({
    kind: resolveKind(name, roles.join("; "), kind),
    name,
    aliases,
    gender,
    role: roles.join("; ") || undefined,
  });
}

/**
 * A heading says what the lines beneath it are, but a name that clearly is not
 * one of those things gets re-read on its own: a sword listed under
 * ORGANISATIONS is a term, not a guild.
 */
function resolveKind(name: string, role: string, kind: BibleEntryKind): BibleEntryKind {
  if (kind !== "organisation" && kind !== "term") return kind;
  if (/\b(guild|order|cult|company|association|house|cabinet|clan|legion|faction|church)\b/i.test(`${name} ${role}`)) {
    return kind;
  }
  return "term";
}

/** A heading is a short all-caps line or a markdown heading, never a colon. */
const isHeadingLine = (line: string): boolean =>
  /^#{1,3}\s/.test(line) || /^[A-Z][A-Z\s&]{2,}:?$/.test(line);

/**
 * Reads a dictionary written as a heading per kind followed by `Name: detail`
 * lines, which is the shape of the project continuity add-on.
 *
 * Unrecognised shapes are skipped rather than guessed at, so a partial paste
 * never fills the panel with noise.
 */
export function parseBibleText(source: string): StoryBible {
  const entries: BibleEntry[] = [];
  let kind: BibleEntryKind = "character";

  for (const raw of source.split(/\r?\n/)) {
    const line = cleanName(raw.trim());
    if (!line) continue;

    if (/^[-*=]{3,}$/.test(line)) continue;

    if (isHeadingLine(line)) {
      kind = kindFromHeading(line.replace(/^#{1,3}\s*/, ""));
      continue;
    }

    const entry = parseEntry(line, kind);
    if (entry) entries.push(entry);
  }

  return { entries };
}
