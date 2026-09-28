import "server-only";

/**
 * Transport for any OpenAI-compatible chat-completions endpoint.
 *
 * The endpoint is configuration, not a hardcoded vendor: `LLM_BASE_URL` can
 * point at OpenAI, xAI, OpenRouter, Groq, a local vLLM/Ollama server, or a
 * proxy in front of any of them. `LLM_API_KEY` stays server-side and is never
 * bundled into the client.
 *
 * A chapter is corrected in two passes. The first reads the passage and writes
 * down what has to change. The second rewrites it with that list in hand. Every
 * stage used to compete for attention inside one completion, and the shallower
 * models dropped most of them.
 *
 * Response parsing lives in model-output.ts so it can be tested without a
 * network call.
 */

import { chunkText } from "./chunker";
import { alignParagraphs } from "./diff";
import type { ParagraphPair } from "./diff";
import { LlmError, parseAnalysis, parseRewrite } from "./model-output";
import { analysePov } from "./pov";
import { formatBibleForPrompt } from "./story-bible";
import { FIXED_TEMPERATURE_MODELS } from "./validate";
import type {
  AnalysisNote,
  ContinuityNote,
  IssueCategory,
  PovMode,
  SpeakerNote,
  StoryBible,
  TonePreset,
} from "./types";
import { ISSUE_CATEGORIES } from "./types";

export { LlmError };

export type LlmProvider = "openai" | "gemini";

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  provider: LlmProvider;
}

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

const GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_DEFAULT_MODEL = "gemini-2.5-flash";

/**
 * Where to send requests and how to talk to it, independent of the key.
 *
 * `readLlmConfig` uses this plus a key, so these are the two functions rather
 * than one that would tie a transport to a credential. A reader who pastes a
 * key with no key on the server still needs the endpoint, the provider, and
 * the timeout; only the key comes from them.
 */
export function readTransport(env: NodeJS.ProcessEnv = process.env): Omit<
  LlmConfig,
  "apiKey"
> {
  // `LLM_PROVIDER` picks the transport. Left unset it follows the base URL, so
  // `LLM_BASE_URL` pointing at Google is all it takes to switch over.
  const provider: LlmProvider =
    env.LLM_PROVIDER?.trim().toLowerCase() === "gemini" ? "gemini" : "openai";

  const baseUrl =
    provider === "gemini"
      ? (env.LLM_BASE_URL?.trim() || GEMINI_DEFAULT_BASE_URL).replace(/\/+$/, "")
      : (env.LLM_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");

  return {
    baseUrl,
    model: env.LLM_MODEL?.trim() || (provider === "gemini" ? GEMINI_DEFAULT_MODEL : "gpt-4o-mini"),
    timeoutMs: Number(env.LLM_TIMEOUT_MS) || 60_000,
    provider,
  };
}

/**
 * Returns the provider config, or null when no key is set.
 *
 * `LLM_PROVIDER` picks the transport. Left unset it follows the base URL, so
 * `LLM_BASE_URL` pointing at Google is all it takes to switch over.
 */
export function readLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig | null {
  const apiKey = env.LLM_API_KEY?.trim();
  if (!apiKey) return null;
  return { ...readTransport(env), apiKey };
}

/**
 * First pass: read the chapter and decide what has to change.
 *
 * Nothing is rewritten here. The model is asked for a list of findings keyed to
 * exact substrings of the passage, which the second pass then applies. Keeping
 * the two apart is what stops the analysis stages from being crowded out by the
 * instruction to produce prose.
 */
const ANALYST_SYSTEM_PROMPT = `You are a Korean web-novel English editor reviewing a machine-translated chapter.

You are not a proofreader. Grammar is one step in the job. The job is to work out what the original author meant, and where the English that reached them fails to say it.

Read the whole chapter before judging any single sentence. A word is only clear in the context of the rest of it.

WORK THROUGH THE CHAPTER IN THIS ORDER
1. Structure. Sort the text into narration, dialogue, internal thought, action, description, and scene breaks. Note where the viewpoint changes.
2. Point of view. Establish who narrates, who thinks, who acts, and who speaks. Read pronouns together with the action around them, the dialogue, and what came before.
3. Names and identities. Bring every name, alias, title, gender, and role to the form the story has established. A transliteration variant is the same character, not a new one.
4. Continuity. Check relationships, identities, locations, and prior events against the dictionary and the rest of the chapter.
5. Meaning. Where a sentence is grammatical but wrong, infer the intended meaning from the scene instead of keeping the broken wording.
6. Register and idiom. Machine translation leaves the wrong register, mistranslated idioms, kinship terms applied to the wrong character, and sentences that follow the source language's word order.
7. Pacing and dialogue. Paragraph length, action-to-reaction rhythm, and whether each line of dialogue sounds like something a person would say.
8. Scene logic. Action, reaction, dialogue, emotion, and consequence should happen in an order a reader can follow.

EVIDENCE
When the text is unclear, treat the surrounding material as the evidence.
- Scene: what is physically happening?
- Dialogue: who would logically say this?
- Character: would this person behave or speak this way?
- Continuity: does it agree with the established facts?
- Language: what is the natural English for that meaning?

OUTPUT
Return JSON with exactly these keys:

{
  "notes": [
    {
      "paragraph": 3,
      "category": "one of: ${ISSUE_CATEGORIES.join(", ")}",
      "title": "short imperative description, max 8 words",
      "excerpt": "a short exact phrase copied from that paragraph that shows the problem",
      "intended": "what the author meant, in one sentence",
      "rewrite": "the replacement wording for that phrase, or empty when only the meaning needs recording"
    }
  ],
  "continuity": [
    {
      "raw": "the alias or variant spelling exactly as it appears in the passage",
      "canonical": "the established name it resolves to",
      "note": "one sentence on what makes the reading correct, optional"
    }
  ]
}

Hard rules:
- "paragraph" is the zero-based index of the paragraph in the passage, counting blank-line-separated blocks.
- "excerpt" MUST be copied exactly from that paragraph. Never paraphrase it.
- "rewrite" is a phrase that replaces the excerpt in place. Leave it empty when the paragraph needs rewriting as a whole rather than at one phrase.
- Report what is actually wrong with this text. A paragraph that reads as natural English gets no note.
- Cap the list at 40 notes for a long chapter, ordered by how much they damage the read.
- "continuity" is for names and identities only. Omit the key when there is nothing to report.
- Do not invent new characters, events, powers, or lore.

Return raw JSON only. No markdown fences, no commentary.`;

/** Second pass: turn the chapter into natural English, guided by the analysis. */
const REWRITER_SYSTEM_PROMPT = `You are a Korean web-novel English editor writing the finished chapter.

You are given the original chapter and a list of what an editor found wrong in it. Your job is to write the chapter the author was trying to write.

PRIMARY OBJECTIVE
Transform the passage into fluent, natural English while preserving:
- the original plot, every event, and the order they happen in
- character intentions, relationships, and emotional meaning
- scene order, point of view, and what each line of dialogue means
- established names, titles, terminology, and anything the dictionary supplied
- the information the chapter exists to deliver

WEB-NOVEL STYLE
Prefer short paragraphs, clear action beats, natural dialogue, internal monologue, and readable scene transitions. Use a one-line paragraph where a beat deserves emphasis. Order events as ACTION, then REACTION, then DIALOGUE, then EMOTION, then CONSEQUENCE. Use em dashes, ellipses, and scene breaks only where they support the rhythm. Keep the register straightforward: this is a web novel, not literary fiction.

MACHINE TRANSLATION
Repair the damage translation leaves behind: wrong register, mistranslated idioms, pronouns pointing at the wrong person, missing subjects, subject and object swapped, kinship terms applied to the wrong character, and sentences that follow the source language's word order. Choose the reading the scene supports whenever the source is genuinely ambiguous.

CROSS-LANGUAGE WORD CHOICE
When a word has no clean English equivalent, choose the English word or phrase that carries the same meaning and the same feeling for the reader. A word-for-word rendering is almost never it. Resolve an ambiguous word by reading the whole chapter first.

INTERNAL THOUGHT
Keep internal thought separate from speech. A thought stays a thought; do not turn it into something said aloud. The reader should be able to tell the difference at a glance.

WORKING FROM THE ANALYSIS
Each finding names a paragraph and, where the problem sits in one phrase, an exact excerpt.
- Apply the rewrite it proposes, adapted so it fits the sentence around it.
- Where no rewrite is proposed, rewrite that paragraph so it says what the finding says it should.
- A finding can be wrong. If the original already reads as natural English, leave it alone.
- Fix what the analysis missed. It is a reading, not a limit.

OUTPUT
Return JSON with exactly one key:

{
  "corrected": "the full polished chapter as one string, preserving paragraph breaks"
}

Hard rules:
- "corrected" MUST keep every paragraph of the input, in the same order, separated by a blank line. Never drop, merge, split, or summarise a paragraph.
- Return the same number of paragraphs you were given.
- The chapter is the deliverable. Do not return a critique, a review, or commentary about the chapter.
- Do not invent. No new characters, events, powers, relationships, motivations, or lore. Add only the connective wording that makes the English read as English.

Return raw JSON only. No markdown fences, no commentary.`;

/** Per-tone instructions, appended to the rewrite prompt. */
const TONE_INSTRUCTIONS: Record<TonePreset, string> = {
  faithful:
    "Stay close to the source wording. Repair grammar, spelling, punctuation, agreement, and machine-translation damage, and change phrasing only where the literal English is not English.",
  polished:
    "Rewrite into natural English at the pace a Korean web novel reads at: short paragraphs, clean beats, and a paragraph break where the scene turns. Keep the author's voice.",
  concise:
    "Cut redundancy, filler, and needless words while keeping every distinct idea and plot beat. Keep the web-novel rhythm.",
  engaging:
    "Sharpen the prose: stronger verbs, varied sentence length, and cleaner openings. Where a word was ambiguous, choose the version a reader finds most immediate. Keep the author's voice and the web-novel rhythm.",
};

/** How a finding reached the rewrite, which the side-by-side view shows. */
export interface Change {
  index: number;
  before: string;
  after: string;
  unchanged: boolean;
  /** Findings the analysis reported against this paragraph. */
  notes: AnalysisNote[];
}

function buildAnalystPrompt(
  text: string,
  categories: IssueCategory[],
  povMode: PovMode,
  bible?: StoryBible,
): string {
  const focus = categories.length > 0 ? categories.join(", ") : "all categories";
  const dictionary = formatBibleForPrompt(bible);

  return [
    `Analyse for these categories: ${focus}.`,
    povMode === "off"
      ? ""
      : povMode === "enforce"
        ? "Note any line of dialogue whose speaker the narration provably contradicts."
        : "Note any line of dialogue whose speaker cannot be established from the text.",
    "Every paragraph is numbered from 0 in the order given below.",
    ...(dictionary ? [dictionary] : []),
    "",
    "PASSAGE:",
    text,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function buildRewriterPrompt(
  text: string,
  notes: AnalysisNote[],
  tone: TonePreset,
  continuity: ContinuityNote[],
): string {
  const lines: string[] = [];

  if (notes.length > 0) {
    lines.push("What the editor found in this chapter:");
    for (const note of notes) {
      const target = note.rewrite
        ? ` -> "${note.rewrite}"`
        : " (rewrite the paragraph, not one phrase)";
      lines.push(
        `- Paragraph ${note.paragraph} [${note.category}] ${note.title}. Meant: ${note.intended}. "${note.excerpt}"${target}`,
      );
    }
  } else {
    lines.push("The editor found nothing that needs fixing. Return the chapter unchanged.");
  }

  if (continuity.length > 0) {
    lines.push("");
    lines.push("Names to settle on:");
    for (const note of continuity) {
      lines.push(`- "${note.raw}" is ${note.canonical}${note.via ? ` (spelled ${note.via} in the source)` : ""}`);
    }
  }

  lines.push("");
  lines.push("PASSAGE:");
  lines.push(text);

  return lines.join("\n");
}

/** OpenAI-compatible chat completions: OpenAI, xAI, OpenRouter, Groq, Ollama. */
async function callOpenAi(config: LlmConfig, messages: ChatMessage[]): Promise<string> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    response_format: { type: "json_object" },
  };

  // Low temperature keeps a rewriting task stable between runs, which is what
  // the app wants. The reasoning models 400 on a non-default value, so they are
  // sent without the parameter rather than with a value they would reject.
  if (!FIXED_TEMPERATURE_MODELS.has(config.model)) {
    body.temperature = 0.3;
  }

  const response = await postJson(
    `${config.baseUrl}/chat/completions`,
    {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body,
    config.timeoutMs,
  );

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content;

  if (!content) throw new LlmError("Provider response contained no content");
  return content;
}

/**
 * Google Gemini via `generateContent`.
 *
 * The key goes in a header rather than the query string so it stays out of logs
 * and error text. Gemini has no JSON response mode, so the JSON contract is
 * restated in the prompt and the reply is parsed by the same reader.
 */
async function callGemini(config: LlmConfig, system: string, user: string): Promise<string> {
  const response = await postJson(
    `${config.baseUrl}/models/${config.model}:generateContent`,
    {
      "Content-Type": "application/json",
      "x-goog-api-key": config.apiKey,
    },
    {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: {
        temperature: 0.3,
        responseMimeType: "application/json",
      },
    },
    config.timeoutMs,
  );

  const payload = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("");

  if (!text) throw new LlmError("Provider response contained no content");
  return text;
}

/** Shared POST that turns a transport or status failure into an `LlmError`. */
async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new LlmError(`Provider request failed: ${reason}`);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new LlmError(
      `Provider returned ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      response.status,
    );
  }

  return response;
}

/** One request to the provider, dispatching on which transport is configured. */
async function ask(
  config: LlmConfig,
  system: string,
  user: string,
): Promise<string> {
  return config.provider === "gemini"
    ? callGemini(config, system, user)
    : callOpenAi(config, [
        { role: "system", content: system },
        { role: "user", content: user },
      ]);
}

/**
 * One paragraph's worth of change, ready for the side-by-side view.
 *
 * The pairing is positional, which holds because the rewriter is told to keep
 * every paragraph in order. The similarity fallback in `alignParagraphs` covers
 * the times it does not.
 */
function toChange(pair: ParagraphPair, notes: AnalysisNote[], index: number): ChapterChange {
  return {
    index,
    before: pair.before,
    after: pair.after ?? pair.before,
    unchanged: pair.unchanged,
    notes: notes.filter((note) => note.paragraph === pair.index),
  };
}

/** How the two passes ran, reported to the reader with the result. */
export interface ChapterChange {
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

export interface CorrectionPass {
  /** The rewritten chapter in full. */
  corrected: string;
  /** One entry per original paragraph. */
  changes: ChapterChange[];
  /** Speaker attribution, present when pov mode is "detect" or "enforce". */
  speakers: SpeakerNote[];
  /** Alias and identity resolutions found against the story bible. */
  continuity: ContinuityNote[];
  /** How many requests this chapter needed. */
  requests: number;
}

/**
 * Corrects a chapter with the configured model, one chunk at a time.
 *
 * A chapter is split into chunks that each fit a request, and every chunk goes
 * through both passes. Throws `LlmError` on any failure so the caller can
 * decide whether to fall back to the local engine.
 */
export async function runCorrection(
  config: LlmConfig,
  text: string,
  tone: TonePreset,
  categories: IssueCategory[],
  povMode: PovMode = "detect",
  bible?: StoryBible,
): Promise<CorrectionPass> {
  const chunks = chunkText(text);

  const corrections: string[] = [];
  const changes: Change[] = [];
  const continuity: ContinuityNote[] = [];
  let requests = 0;

  for (const chunk of chunks) {
    const paragraphs = chunk.text.split(/\n{2,}/).filter(Boolean).length;
    let notes: AnalysisNote[] = [];
    let chunkContinuity: ContinuityNote[] = [];

    // Every chunk goes through both passes, including a single-paragraph
    // paste. The analysis is what tells the rewriter which problems are
    // deliberate, and it is the only source of the findings the reader reads
    // beside the rewrite.
    const analysis = parseAnalysis(
      await ask(
        config,
        ANALYST_SYSTEM_PROMPT,
        buildAnalystPrompt(chunk.text, categories, povMode, bible),
      ),
      paragraphs,
    );
    requests += 1;
    notes = analysis.notes;
    chunkContinuity = analysis.continuity;

    const rewritten = parseRewrite(
      await ask(
        config,
        `${REWRITER_SYSTEM_PROMPT}\n\n${TONE_INSTRUCTIONS[tone]}`,
        buildRewriterPrompt(chunk.text, notes, tone, chunkContinuity),
      ),
    );
    requests += 1;

    const pairs = alignParagraphs(chunk.text, rewritten.corrected);
    // A chunk starts partway through the chapter, so the offset carries the
    // position through to the whole-chapter list the reader sees.
    const offset = changes.length;
    for (const pair of pairs) {
      changes.push(toChange(pair, notes, pair.index + offset));
    }

    corrections.push(rewritten.corrected);
    continuity.push(...chunkContinuity);
  }

  return {
    corrected: corrections.join("\n\n"),
    changes,
    speakers: povMode === "off" ? [] : analysePov(corrections.join("\n\n"), povMode).speakers,
    continuity,
    requests,
  };
}
