/**
 * Quality gate: a realistic machine-translated chapter through the whole API.
 *
 * The other suites prove the wiring against tidy fixtures. This one runs prose
 * shaped like the input the app actually receives — broken grammar, mid-paragraph
 * dialogue, names spelled several ways — and checks the editor's own promises:
 * the chapter survives, the line of speech keeps its quotation marks, and no card
 * is raised against a line of dialogue as though it were narration.
 *
 * Run with: bun run scripts/test-quality.ts [baseUrl] [mockUrl]
 * Needs the app running: bun run dev
 *
 * This suite always sends a story dictionary, because the chapter's names are
 * the point of the fixture. When it is pointed at the mock provider, the mock
 * is told to expect that dictionary; the two arguments are both optional.
 */

const BASE = process.argv[2] || "http://127.0.0.1:3000";
const MOCK = process.argv[3] || "http://127.0.0.1:4010";

const CHAPTER = `Chapter 12

Mardol stood at the edge of the Temple of Tarden, and her heart was becoming
embarrassed. She was not able to believe it. The Glass Knight, she thought, was
supposed to be impartial. She raised her glass mask, and she was looking at the
crowd, and the crowd was looking at her.

"Are you still intending to do that?"

"Yes," said Soo-hyun. "I am decided."

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

  // The chapter is the one fixture with a dictionary attached, so the mock is
  // told what to expect. Without this the run is rejected for carrying a
  // dictionary the mock was not looking for, and the whole chapter falls back to
  // the rules engine, which would make every check below meaningless.
  const expects = await fetch(`${MOCK}/__mock/expect-dictionary?value=1`).then(
    () => true,
    () => false,
  );

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
    requests: number;
    fallbackReason?: string;
    changes: Array<{
      index: number;
      before: string;
      after: string;
      unchanged: boolean;
      notes: Array<{
        category: string;
        title: string;
        excerpt: string;
        intended: string;
        rewrite: string;
      }>;
    }>;
    speakers: Array<{ line: string; speaker: string | null; basis: string }>;
    continuity: Array<{ raw: string; canonical: string; via?: string; note?: string }>;
  };

  const corrected = result.corrected;
  const notes = result.changes.flatMap((change) => change.notes ?? []);
  const pasted = CHAPTER.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);

  // Everything below checks a model rewrite. A run that fell back to the rules
  // engine would pass most of them while proving nothing, so the reason is
  // printed rather than left to be inferred from a count.
  if (result.engine !== "llm") {
    console.error(`  note the rules engine answered this run: ${result.fallbackReason ?? "no reason given"}`);
    console.error(`  note the mock provider was reachable: ${expects}`);
  }

  // --------------------------------------------------- the side-by-side
  // The view's contract is that the left column is the reader's own text, one
  // row per paragraph they pasted. Everything else hangs off that.
  check(
    "one row per pasted paragraph",
    result.changes.length === pasted.length,
    `changes=${result.changes.length}, paragraphs=${pasted.length}`,
  );
  check(
    "the left column is the pasted paragraph, verbatim",
    result.changes.every((change, position) => change.before === pasted[position]),
    result.changes.find((change, position) => change.before !== pasted[position])?.before.slice(0, 80) ?? "",
  );
  check(
    "the rows keep the order of the chapter",
    result.changes.every((change, position) => change.index === position),
    JSON.stringify(result.changes.map((change) => change.index)),
  );
  check(
    "the right column holds a rewrite for every row",
    result.changes.every((change) => change.after.trim().length > 0),
  );
  check(
    "a row the model left alone is marked unchanged",
    result.changes.every((change) => change.unchanged === (change.before === change.after)),
  );
  check(
    "findings reach the reader on the side-by-side view",
    notes.length > 0,
    `notes=${notes.length}`,
  );

  // ---------------------------------------------------------- the chapter
  check("the corrected chapter comes back non-empty", corrected.length > 0);
  // The chapter has to come through: every scene, speaker, and place the
  // reader pasted is still there. The wording is the model's to choose, so a
  // stilted phrase is allowed to become natural English, which is the whole
  // point of the run.
  check("every scene the input established is still in the output", (() => {
    for (const line of [
      "Mardol stood at the edge of the Temple of Tarden",
      "The Hall was",
      "Minjun said",
      "Giyu",
    ]) {
      if (!corrected.includes(line)) return false;
    }
    return true;
  })(), corrected.slice(0, 200));
  check("the output is no shorter than the input", corrected.length >= CHAPTER.length * 0.9,
    `in ${CHAPTER.length}, out ${corrected.length}`);

  // ------------------------------------------------------------- grammar
  check("subject-verb agreement is repaired", !/\bIt have\b/.test(corrected), corrected.match(/\bIt have\b/)?.[0]);
  // A stilted machine phrase is the model's job to reword, so the guarantee is
  // narrower: whatever the editor reports, the text it points at is really in
  // the chapter, and the replacement it proposes really is in the rewrite.
  check("no finding quotes a phrase the chapter does not contain", (() => {
    const flat = corrected.replace(/\s+/g, " ");
    return notes.every(
      (note) =>
        note.excerpt.length < 3 || CHAPTER.includes(note.excerpt) || flat.includes(note.excerpt.trim()),
    );
  })(), notes
    .filter(
      (note) =>
        note.excerpt.length >= 3 &&
        !CHAPTER.includes(note.excerpt) &&
        !corrected.replace(/\s+/g, " ").includes(note.excerpt.trim()),
    )
    .map((note) => `  ${JSON.stringify(note.excerpt)}`).join(""));

  check("a finding never proposes a replacement the rewrite does not use", (() => {
    const flat = corrected.replace(/\s+/g, " ");
    return notes.every(
      (note) => note.rewrite.length < 3 || flat.includes(note.rewrite.trim()),
    );
  })(), notes
    .filter((note) => note.rewrite.length >= 3 && !corrected.replace(/\s+/g, " ").includes(note.rewrite.trim()))
    .map((note) => `  ${JSON.stringify(note.rewrite)}`).join(""));

  check("every finding explains itself", notes.every(
    (note) => note.title.length > 0 && note.intended.length > 0,
  ));

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

  check("no finding is raised against a line of dialogue as a missing subject", (() => {
    const bogus = notes.filter(
      (note) => note.title.toLowerCase().includes("missing subject")
        && /^\s*["\u201C]/.test(note.excerpt),
    );
    return bogus.length === 0;
  })(), notes
    .filter((note) => note.title.toLowerCase().includes("missing subject"))
    .map((note) => `  ${JSON.stringify(note.excerpt)}`).join(""));

  check("a chapter heading is not flagged as a fragment", (() => {
    return notes.every(
      (note) => !note.title.toLowerCase().includes("missing subject")
        || !/^\s*(chapter|part|volume)\b/i.test(note.excerpt),
    );
  })(), "a heading was flagged");

  check("a line carrying its own speaker tag is not flagged as a fragment", (() => {
    return notes.every(
      (note) => !note.title.toLowerCase().includes("missing subject")
        || !/\b(said|asked|replied|whispered)\b/i.test(note.excerpt),
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

  // --------------------------------------------------- the two-pass result
  // The ten-stage pipeline report is gone. What the reader gets instead is the
  // request count and the findings, so those are what this gate checks.
  check("the two passes ran for the chapter", result.requests >= 2, `requests=${result.requests}`);
  check("a rules run made no provider request", result.engine !== "rules" || result.requests === 0,
    `engine=${String(result.engine)} requests=${result.requests}`);

  // The dictionary renamed the alias before the model ever saw the chapter, so
  // the left column still carries the reader's spelling and the right column
  // carries the resolved one. That difference is the rename, shown side by side.
  check("a renamed name is visible as a difference on one row", (() => {
    return result.changes.some((change) => change.before !== change.after);
  })(), "every row is unchanged");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

await runQualityTests();

export {};
