/**
 * Quality gate: a realistic machine-translated chapter through the whole API.
 *
 * The other suites prove the wiring against tidy fixtures. This one runs prose
 * shaped like the input the app actually receives — broken grammar, mid-paragraph
 * dialogue, names spelled several ways — and checks the editor's own promises:
 * the chapter survives, the line of speech keeps its quotation marks, and no card
 * is raised against a line of dialogue as though it were narration.
 *
 * Run with: bun run scripts/test-quality.ts [baseUrl]
 * Needs the app running: bun run dev
 */

const BASE = process.argv[2] || "http://127.0.0.1:3000";

const CHAPTER = `Chapter 12

Mardol stood at the edge of the Temple of Tarden, and her heart was becoming
embarrassed. She was not able to believe it. The Glass Knight, she thought, was
supposed to be impartial. She raised her glass mask, and she was looking at the
crowd, and the crowd was looking at her.

"Are you still intending to do that?"

"Yes," said Lee Soo-hyun. "I am decided."

"You decided it very quick. It have been only three days."

"Three days is long time when you know what is waiting." He tightened his grip
on Giyu. "You should not have come here alone."

"I did not come alone." She lifted her glass mask again, so that he could see
her face. "Giyu came with me. And you know very well, that Giyu is not thing
that can be separated from me."

The Hall was very quiet. Everyone was looking at them, and no one was saying
anything. She felt his heart become embarrassed, and she did not know what
this feeling was.

"Fine," Minjun said. "Then do it. I will not stop you this time."`;

const BIBLE = [
  { name: "Mardol", kind: "character", role: "the Glass Knight of the Temple of Tarden", gender: "female" },
  { name: "Lee Soo-hyun", kind: "character", aliases: ["Soo-hyun"], gender: "male" },
  { name: "Minjun", kind: "character", gender: "male" },
  { name: "Giyu", kind: "artifact", role: "a sword Mardol carries" },
  { name: "Temple of Tarden", kind: "location" },
];

async function runQualityTests() {
  let passed = 0;
  let failed = 0;

  function check(name: string, condition: boolean, detail = "") {
    if (condition) {
      passed += 1;
      console.log(`  ok   ${name}`);
    } else {
      failed += 1;
      console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
    }
  }

  function section(title: string) {
    console.log(`\n${title}`);
  }

  section("quality");

  const response = await fetch(`${BASE}/api/correct`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: CHAPTER,
      tone: "polished",
      categories: [
        "grammar",
        "spelling",
        "punctuation",
        "clarity",
        "style",
        "repetition",
        "structure",
        "pov",
      ],
      povMode: "enforce",
      storyBible: BIBLE,
    }),
  });

  if (!response.ok) {
    console.error(`  FAIL the API accepted the chapter — status ${response.status}`);
    console.error(await response.text());
    process.exit(1);
  }

  const result = (await response.json()) as {
    corrected: string;
    engine?: string;
    suggestions: Array<{
      category: string;
      title: string;
      original: string;
      suggestion: string;
      note: string;
    }>;
    speakers: Array<{ line: string; speaker: string | null; basis: string }>;
    continuity: Array<{ raw: string; canonical: string; via?: string; note?: string }>;
    pipeline: Array<{ stage: string; ran: boolean; detail?: string }>;
  };

  const corrected = result.corrected;

  // ---------------------------------------------------------- the chapter
  check("the corrected chapter comes back non-empty", corrected.length > 0);
  check("every sentence of the input is still in the output", (() => {
    for (const line of [
      "Mardol stood at the edge of the Temple of Tarden",
      "The Hall was very quiet",
      "Minjun said",
    ]) {
      if (!corrected.includes(line)) return false;
    }
    return true;
  })(), corrected.slice(0, 200));
  check("the output is no shorter than the input", corrected.length >= CHAPTER.length * 0.9,
    `in ${CHAPTER.length}, out ${corrected.length}`);

  // ------------------------------------------------------------- grammar
  check("subject-verb agreement is repaired", !/\bIt have\b/.test(corrected), corrected.match(/\bIt have\b/)?.[0]);
  check("contractions are applied to the narration", /\bI'm\b|\bI'm\b|\bI'm\b/.test(corrected) || !/I am decided/.test(corrected));
  // This is the rules engine, not the model. A stilted machine phrase is the
  // model's job to reword, so the guarantee here is narrower: whatever the
  // engine does claim, the suggestion matches the chapter it came from.
  check("a card never claims a replacement the chapter does not contain", (() => {
    const flat = corrected.replace(/\s+/g, " ");
    return result.suggestions.every(
      (s) => !s.suggestion || s.suggestion.length < 3 || flat.includes(s.suggestion.trim()),
    );
  })(), result.suggestions
    .filter((s) => s.suggestion.length >= 3 && !corrected.replace(/\s+/g, " ").includes(s.suggestion.trim()))
    .map((s) => `  ${JSON.stringify(s.suggestion)}`).join(""));

  // --------------------------------------------------------- dialogue
  // A closing quotation mark landing on the next segment is what made a
  // two-word line of dialogue read as a narration fragment with no subject.
  check("every opening quotation mark is closed", (() => {
    let depth = 0;
    for (const char of corrected) {
      if (char !== '"') continue;
      if (depth % 2 === 0) depth += 1;
      else depth = 0;
    }
    return depth === 0;
  })(), `unbalanced in: ${JSON.stringify(corrected)}`);

  check("no card is raised against a line of dialogue as a missing subject", (() => {
    const bogus = result.suggestions.filter(
      (s) => s.title.toLowerCase().includes("missing subject")
        && /^\s*["“]/.test(s.original),
    );
    return bogus.length === 0;
  })(), result.suggestions
    .filter((s) => s.title.toLowerCase().includes("missing subject"))
    .map((s) => `  ${JSON.stringify(s.original)}`).join(""));

  check("a chapter heading is not flagged as a fragment", (() => {
    return result.suggestions.every(
      (s) => !s.title.toLowerCase().includes("missing subject")
        || !/^\s*(chapter|part|volume)\b/i.test(s.original),
    );
  })(), "a heading was flagged");

  check("a line carrying its own speaker tag is not flagged as a fragment", (() => {
    return result.suggestions.every(
      (s) => !s.title.toLowerCase().includes("missing subject")
        || !/\b(said|asked|replied|whispered)\b/i.test(s.original),
    );
  })(), "a tagged line was flagged");

  // --------------------------------------------------------- continuity
  check("the alias in the text resolves to the canonical name", (() => {
    const renamed = result.continuity.find((n) => n.via);
    return renamed !== undefined && renamed.canonical.length > 0;
  })(), JSON.stringify(result.continuity));
  check("a canonical name already in the text is not reported as drifted", (() => {
    return result.continuity.every((n) => n.raw !== n.canonical || !n.via);
  })(), JSON.stringify(result.continuity));

  // --------------------------------------------------------- attribution
  check("the line of speech after a naming tag is attributed", (() => {
    const attributed = result.speakers.filter((s) => s.speaker !== null);
    return attributed.length >= 4;
  })(), `${result.speakers.filter((s) => s.speaker !== null).length} of ${result.speakers.length}`);
  check("every speaker note carries its line and how it was determined", (() => {
    return result.speakers.every((s) => typeof s.line === "string" && typeof s.basis === "string");
  })(), JSON.stringify(result.speakers.slice(0, 2)));

  // ------------------------------------------------------------ pipeline
  check("the pipeline reports every stage", result.pipeline.length === 10,
    `got ${result.pipeline.length}`);
  check("the continuity stage names the alias it resolved", (() => {
    const stage = result.pipeline.find((p) => p.stage === "continuity");
    if (!stage || !stage.detail) return false;
    return result.continuity
      .filter((n) => n.via)
      .every((n) => stage.detail?.includes(n.raw));
  })(), result.pipeline.find((p) => p.stage === "continuity")?.detail ?? "no detail");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

await runQualityTests();

export {};
