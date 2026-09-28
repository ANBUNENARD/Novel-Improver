/**
 * Shared types for the correction pipeline.
 *
 * The shape below is the contract between the API route, the engine, and the
 * editor UI. Keep it stable: the client renders `suggestions` and `corrected`
 * directly, so renaming a field is a breaking change across all three.
 */

/** Categories surfaced as filter chips in the editor. */
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

export const POV_MODE_LABELS: Record<PovMode, string> = {
  off: "Off",
  detect: "Detect",
  enforce: "Fix",
};

export const POV_MODE_DESCRIPTIONS: Record<PovMode, string> = {
  off: "Skip point-of-view analysis.",
  detect: "Flag unclear speakers and POV slips without changing any text.",
  enforce: "Also rewrite the narration that has a provably wrong speaker.",
};

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

export const TONE_DESCRIPTIONS: Record<TonePreset, string> = {
  faithful: "Fix errors, change nothing else.",
  polished: "Improve flow and rhythm, keep the author's voice.",
  concise: "Cut redundancy and tighten sentences.",
  engaging: "Sharpen openings and vary sentence length.",
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

/** The ten stages of the web-novel polishing pass, in the order they run. */
export const PIPELINE_STAGES = [
  "parse",
  "pov",
  "normalize",
  "continuity",
  "meaning",
  "rewrite",
  "pacing",
  "dialogue",
  "logic",
  "consistency",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const PIPELINE_STAGE_LABELS: Record<PipelineStage, string> = {
  parse: "Parse",
  pov: "POV",
  normalize: "Names",
  continuity: "Continuity",
  meaning: "Meaning",
  rewrite: "Rewrite",
  pacing: "Pacing",
  dialogue: "Dialogue",
  logic: "Logic",
  consistency: "Final check",
};

export const PIPELINE_STAGE_DESCRIPTIONS: Record<PipelineStage, string> = {
  parse: "Narration, dialogue, thoughts, actions, and scene breaks identified.",
  pov: "Who narrates, who thinks, and who speaks each line.",
  normalize: "Names, aliases, titles, and genders read against the story bible.",
  continuity: "Names, identities, terms, and relationships checked for drift.",
  meaning: "Broken literal translations read for what the author intended.",
  rewrite: "Awward literal phrasing rewritten as natural English.",
  pacing: "Paragraph length and the action-to-consequence rhythm.",
  dialogue: "Speaker tags, replies, and character voice checked.",
  logic: "Actions, reactions, and consequences put in order.",
  consistency: "A last pass over POV, names, terms, and plot preservation.",
};

/** One stage and what it found. Drives the strip above the result. */
export interface PipelineReportEntry {
  stage: PipelineStage;
  /** One short line describing what the stage did, shown on hover. */
  detail?: string;
  /** False when the stage was skipped because the matching control was off. */
  ran: boolean;
}

/** One flagged passage. `original` is echoed back for the side-by-side diff. */
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
}

/** Aggregate counts for the summary strip above the editor. */
export interface AnalysisSummary {
  wordCount: number;
  sentenceCount: number;
  averageSentenceLength: number;
  readability: {
    score: number;
    label: string;
  };
  issuesByCategory: Partial<Record<IssueCategory, number>>;
}

export interface CorrectionResult {
  /** The rewritten text in full. */
  corrected: string;
  suggestions: Suggestion[];
  summary: AnalysisSummary;
  /** Speaker attribution, present when pov mode is "detect" or "enforce". */
  speakers?: SpeakerNote[];
  /** Alias and identity resolutions found against the story bible. */
  continuity?: ContinuityNote[];
  /** What each stage of the polishing pass did on this run. */
  pipeline?: PipelineReportEntry[];
  /** `"llm"` when a model produced the rewrite, `"rules"` for the local fallback. */
  engine: "llm" | "rules";
  model?: string;
  /** Populated when the LLM call failed and the local engine took over. */
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
