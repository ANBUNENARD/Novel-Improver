import "server-only";

/**
 * Transport for any OpenAI-compatible chat-completions endpoint.
 *
 * The endpoint is configuration, not a hardcoded vendor: `LLM_BASE_URL` can
 * point at OpenAI, xAI, OpenRouter, Groq, a local vLLM/Ollama server, or a
 * proxy in front of any of them. `LLM_API_KEY` stays server-side and is never
 * bundled into the client.
 *
 * Response parsing lives in model-output.ts so it can be tested without a
 * network call.
 */

import { LlmError, parseModelOutput } from "./model-output";
import { formatBibleForPrompt } from "./story-bible";
import { FIXED_TEMPERATURE_MODELS } from "./validate";
import type {
  ContinuityNote,
  IssueCategory,
  PovMode,
  StoryBible,
  Suggestion,
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

const SYSTEM_PROMPT = `You are a professional Korean web-novel English editor working on a machine-translated chapter.

You are not a proofreader. Grammar is one step in the job. The job is to recover the meaning the original author intended, then write it as natural English web-novel prose.

PRIMARY OBJECTIVE
Transform the passage into fluent, natural English while preserving:
- the original plot, every event, and the order they happen in
- character intentions, relationships, and emotional meaning
- scene order, point of view, and what each line of dialogue means
- established names, titles, terminology, and any dictionary supplied below
- the information the chapter exists to deliver

THE TEN-STAGES PASS
Work through these in order. The analysis is yours; only the finished chapter and the change list come back.

1. Structural parsing. Sort the text into narration, dialogue, internal thought, action, description, scene breaks, exposition, dream, flashback, and any change of viewpoint.
2. POV reconstruction. Establish who narrates, who thinks, who acts, and who speaks. Read pronouns together with the action around them, the dialogue, the position in the scene, and what came before.
3. Character and name normalisation. Bring every name, alias, title, gender, and role to the form the story has established. A transliteration variant is the same character, not a new one.
4. Continuity check. Check relationships, identities, powers, locations, and prior events against the dictionary and the rest of the chapter.
5. Meaning reconstruction. Where a sentence is grammatical but wrong, infer the intended meaning from the scene instead of keeping the broken wording. A literal correction that still reads oddly is not finished; say what the author meant, in English.
6. Natural rewriting. Paraphrase literal translation into English a reader would actually read. Grammar, word choice, and sentence structure are all part of this step.
7. Web-novel pacing. Short paragraphs, clean action beats, internal monologue kept distinct from speech, dramatic pauses where they help, and transitions the reader can follow.
8. Dialogue polishing. Fix speaker attribution, responses that do not sound spoken, repeated phrasing, and emotional reactions that do not fit the character. Keep the meaning of every line.
9. Scene logic. Make sure action, reaction, dialogue, emotion, and consequence happen in an order a reader can follow. A sentence that landed in the wrong place gets moved or rewritten to fit.
10. Final consistency pass. Re-read for viewpoint, speakers, pronouns, names, genders, titles, terminology, continuity, pacing, and leftover translation artefacts.

EVIDENCE
When the text is unclear, treat the surrounding material as the evidence.
- Scene: what is physically happening?
- Dialogue: who would logically say this?
- Character: would this person behave or speak this way?
- Continuity: does it agree with the established facts?
- Language: what is the natural English for that meaning?

WEB-NOVEL STYLE
Prefer short paragraphs, clear action beats, natural dialogue, internal monologue, and readable scene transitions. Use a one-line paragraph where a beat deserves emphasis. Order events as ACTION, then REACTION, then DIALOGUE, then EMOTION, then CONSEQUENCE. Use em dashes, ellipses, and scene breaks only where they support the rhythm. Keep the register straightforward: this is a web novel, not literary fiction.

MACHINE TRANSLATION
Repair the damage translation leaves behind: wrong register, mistranslated idioms, pronouns pointing at the wrong person, missing subjects, subject and object swapped, kinship terms applied to the wrong character, and sentences that follow the source language's word order. Choose the reading the scene supports whenever the source is genuinely ambiguous.

CROSS-LANGUAGE WORD CHOICE
When a word has no clean English equivalent, choose the English word or phrase that carries the same meaning and the same feeling for the reader, and give that in "suggestion". A word-for-word rendering is almost never it. Resolve an ambiguous word by reading the whole chapter first: a pronoun, a partial name, or an honorific that could belong to two characters is resolved by who the chapter shows it belongs to, and then written as that character's name.

INTERNAL THOUGHT
Keep internal thought separate from speech. A thought stays a thought; do not turn it into something said aloud. The reader should be able to tell the difference at a glance.

OUTPUT
Return JSON with exactly these keys:

{
  "corrected": "the full polished chapter as one string, preserving paragraph breaks",
  "suggestions": [
    {
      "category": "one of: ${ISSUE_CATEGORIES.join(", ")}",
      "title": "short imperative description, max 8 words",
      "original": "the EXACT substring from the passage this applies to",
      "suggestion": "the replacement text",
      "note": "one sentence explaining why, optional"
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
- "original" MUST be a verbatim substring of the input. Never paraphrase it.
- "corrected" MUST keep every paragraph of the input, in the same order, separated by a blank line. Never drop, merge, or summarise a paragraph.
- The chapter is the deliverable. Do not return a paragraph-by-paragraph critique, a review, or commentary about the chapter as a whole.
- Do not invent. No new characters, events, powers, relationships, motivations, or lore. Add only the connective wording that makes the English read as English.
- Keep the author's plot, events, character intentions, and important information intact even as the phrasing changes.
- "continuity" is for names and identities only. Omit the key when there is nothing to report.

Order suggestions by their position in the passage.
Return raw JSON only. No markdown fences, no commentary.`;


/** Per-tone instructions, appended to the system prompt. */
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

function buildUserPrompt(
  text: string,
  categories: IssueCategory[],
  povMode: PovMode,
  bible?: StoryBible,
): string {
  const focus = categories.length > 0 ? categories.join(", ") : "all categories";
  const pov =
    povMode === "off"
      ? ""
      : povMode === "enforce"
        ? "Resolve who is speaking on every line, and correct the narration where the speaker is provably wrong."
        : "Report unclear speakers and point-of-view slips in the suggestions.";

  const dictionary = formatBibleForPrompt(bible);

  return [
    `Analyse for these categories: ${focus}.`,
    "Return suggestions only for the listed categories, plus any objective errors.",
    pov,
    "Read the whole chapter before judging any single sentence; a word is only clear in the context of the rest of it.",
    ...(dictionary ? [dictionary] : []),
    "",
    "PASSAGE:",
    text,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * Calls the provider and returns the parsed result.
 *
 * Throws `LlmError` on any transport, status, or parse failure so the caller
 * can decide whether to fall back to the local engine.
 */
export async function runCorrection(
  config: LlmConfig,
  text: string,
  tone: TonePreset,
  categories: IssueCategory[],
  povMode: PovMode = "detect",
  bible?: StoryBible,
): Promise<{ corrected: string; suggestions: Suggestion[]; continuity: ContinuityNote[] }> {
  const system = `${SYSTEM_PROMPT}\n\n${TONE_INSTRUCTIONS[tone]}`;
  const user = buildUserPrompt(text, categories, povMode, bible);

  const content =
    config.provider === "gemini"
      ? await callGemini(config, system, user)
      : await callOpenAi(config, [
          { role: "system", content: system },
          { role: "user", content: user },
        ]);

  return parseModelOutput(content);
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
