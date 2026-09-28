/**
 * Shared types for the correction pipeline.
 *
 * The shape below is the contract between the API route, the engine, and the
 * editor UI. Keep it stable: the client renders `changes` directly, so renaming
 * a field is a breaking change across all three.
 */

/** Categories the analyst pass can report on. */
export type IssueCategory =
  | "grammar"
  | "spelling"
  | "clarity"
  | "style"
  | "punctuation"
  | "repetition"
  | "structure"
  | "pov";

export const ISSUE_CATEGORIES: IssueCategory[] = [
  "grammar",
  "spelling",
  "punctuation",
  "clarity",
  "style",
  "repetition",
  "structure",
  "pov",
];

export const CATEGORY_LABELS: Record<IssueCategory, string> = {
  grammar: "Grammar",
  spelling: "Spelling",
  punctuation: "Punctuation",
  clarity: "Clarity",
  style: "Style",
  repetition: "Repetition",
  structure: "Structure",
  pov: "POV & speakers",
};

/** How the checker reads a passage for point-of-view problems. */
export type PovMode = "off" | "detect" | "enforce";

export const POV_MODES: PovMode[] = ["off", "detect", "enforce"];

/** One dialogue line and who the checker believes is speaking it. */
export interface SpeakerNote {
  /** Zero-based index of the dialogue block in the passage. */
  index: number;
  /** Name the checker attributed the line to, or null when it could not tell. */
  speaker: string | null;
  /** The dialogue text itself, without the surrounding quotation marks. */
  line: string;
  /** How the speaker was determined. */
  basis: "tag" | "carried" | "beat" | "ambiguous";
  /** True when the following narration names a different speaker. */
  contradictedBy?: string;
  /** Present when the checker proposes a concrete replacement. */
  fix?: {
    original: string;
    suggestion: string;
    title: string;
    note: string;
    /**
     * Offset of `original` in the source text. Recorded during analysis because
     * the same tag text repeats across an exchange, and searching for it later
     * would resolve every repeat to the first occurrence.
     */
    at?: number;
    /** Length of the span starting at `at`. */
    length?: number;
    /** What to put in the span. Empty means the span is deleted outright. */
    replacement?: string;
  };
}

/** How aggressively to rewrite. Ordered from faithful to bold. */
export type TonePreset = "faithful" | "polished" | "concise" | "engaging";

export const TONE_PRESETS: TonePreset[] = [
  "faithful",
  "polished",
  "concise",
  "engaging",
];

export const TONE_LABELS: Record<TonePreset, string> = {
  faithful: "Faithful",
  polished: "Polished",
  concise: "Concise",
  engaging: "Engaging",
};

/** One kind of established fact the continuity layer can hold. */
export type BibleEntryKind = "character" | "location" | "organisation" | "term";

export const BIBLE_ENTRY_KINDS: BibleEntryKind[] = [
  "character",
  "location",
  "organisation",
  "term",
];

export const BIBLE_KIND_LABELS: Record<BibleEntryKind, string> = {
  character: "Character",
  location: "Location",
  organisation: "Organisation",
  term: "Term",
};

/** "male" | "female" | "other", or null when the entry has no stated gender. */
export type Gender = "male" | "female" | "other";

/**
 * One line of the story bible.
 *
 * `name` is the canonical form every alias resolves to, which is what makes a
 * machine-translation variant ("Fine" for "Phine") normalisable instead of
 * looking like a new character.
 */
export interface BibleEntry {
  id: string;
  kind: BibleEntryKind;
  /** Canonical name as the story spells it. */
  name: string;
  /** Other names, titles, and transliteration variants for the same entry. */
  aliases: string[];
  gender?: Gender;
  /** Title, role, or relationship, e.g. "Demon King of Omniscience". */
  role?: string;
  /** Free-form facts the editor must keep consistent. */
  notes?: string;
}

/** The continuity dictionary attached to a correction request. */
export interface StoryBible {
  entries: BibleEntry[];
}

/**
 * A name that was found in the passage and resolved against the bible.
 *
 * `raw` is the exact substring the model reported, so the card can show what
 * the source text actually said.
 */
export interface ContinuityNote {
  /** The variant found in the text, e.g. "Fine". */
  raw: string;
  /** The canonical name it resolves to, e.g. "Phine". */
  canonical: string;
  /** The alias on the bible entry that matched, when there was one. */
  via?: string;
  /** The sentence the match was read in, for context. */
  context?: string;
  note?: string;
}

/**
 * One thing the analyst found in a chapter.
 *
 * The notes are what makes a two-pass rewrite better than one big prompt: the
 * rewriter is told what each paragraph got wrong before it writes, and the
 * reader can see the reasoning next to the change.
 */
export interface AnalysisNote {
  /** Zero-based paragraph index this applies to. */
  paragraph: number;
  category: IssueCategory;
  /** Short imperative description, e.g. "Drop the translator's filler". */
  title: string;
  /** A short exact phrase copied from that paragraph. */
  excerpt: string;
  /** What the author meant, in one sentence. */
  intended: string;
  /** Replacement wording for the excerpt. Empty when the paragraph needs a fuller rewrite. */
  rewrite: string;
}

/**
 * One paragraph's change, as the side-by-side view renders it.
 *
 * `before` is the reader's own text and `after` is the rewrite. A reader keeps
 * or undoes each one independently, so the final export is assembled from
 * whatever they chose.
 */
export interface Change {
  /** Position in the original chapter, starting at zero. */
  index: number;
  /** The paragraph as the reader pasted it. */
  before: string;
  /** The paragraph as the model rewrote it. */
  after: string;
  /** True when the rewrite left this paragraph alone. */
  unchanged: boolean;
  /** Findings the analyst reported against this paragraph. */
  notes: AnalysisNote[];
}

/**
 * One flagged passage from a rule the engine applies without a model.
 *
 * This never reaches the reader directly. The rules engine collects these while
 * it edits, and `pairWithSuggestions` folds them into the `Change` entries the
 * side-by-side view renders.
 */
export interface Suggestion {
  id: string;
  category: IssueCategory;
  /** Short imperative description, e.g. "Double comparative needs a word." */
  title: string;
  /** The exact source text this applies to. */
  original: string;
  /** Suggested replacement for `original`. */
  suggestion: string;
  /** Optional one-sentence rationale shown under the title. */
  note?: string;
  /**
   * Where the text sat in the input before the edit, as a character offset.
   *
   * The rules engine edits in place and never renumbers, so this is what places
   * a finding on the right paragraph once a rewrite has moved the text around.
   */
  at?: number;
}

export interface CorrectionResult {
  /** The rewritten chapter in full, with every accepted change applied. */
  corrected: string;
  /** One entry per original paragraph, for the side-by-side view. */
  changes: Change[];
  /** Alias and identity resolutions found against the story bible. */
  continuity: ContinuityNote[];
  /** Speaker attribution, present when pov mode is "detect" or "enforce". */
  speakers: SpeakerNote[];
  /** `"llm"` when a model produced the rewrite, `"rules"` for the local fallback. */
  engine: "llm" | "rules";
  model?: string;
  /** How many provider requests this chapter needed. */
  requests: number;
  /**
   * Populated when the model call failed and the local engine took over.
   *
   * The result is still usable, so this is a warning rather than an error, and
   * the editor shows it prominently instead of quietly downgrading the work.
   */
  fallbackReason?: string;
}

/** Request body accepted by POST /api/correct. */
export interface CorrectRequest {
  text: string;
  tone: TonePreset;
  categories: IssueCategory[];
  povMode: PovMode;
  storyBible?: StoryBible;
}
