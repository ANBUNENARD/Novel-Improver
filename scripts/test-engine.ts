/**
 * Engine self-test.
 *
 * Exercises the deterministic parts of the pipeline with no network call and no
 * API key: text statistics, the sentence splitter's abbreviation handling, the
 * local correction rules, the model-output validator, and request validation.
 *
 * Run with: npm run test:engine
 *
 * Wrapped so top-level bindings stay file-scoped. The project type check
 * otherwise treats these scripts as one shared global scope, and same-named
 * bindings in sibling scripts collide.
 */

import { countWords, readabilityOf, splitSentences } from "../lib/text-stats";
import { correctLocally } from "../lib/local-engine";
import { analysePov, applyPovFixes, extractDialogue } from "../lib/pov";
import { LlmError, parseModelOutput } from "../lib/model-output";
import { defaultBible, parseBibleText } from "../lib/default-bible";
import { buildPipelineReport } from "../lib/pipeline";
import { findContinuityNotes, formatBibleForPrompt, normaliseBible, normaliseNames } from "../lib/story-bible";
import { validateRequest } from "../lib/validate";
import { ISSUE_CATEGORIES, PIPELINE_STAGES } from "@/lib/types";
import type { StoryBible } from "@/lib/types";

function runEngineTests() {
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

  // ------------------------------------------------------------ statistics
  section("text-stats");

  check("splits two plain sentences", splitSentences("One. Two.").length === 2);
  check(
    "keeps abbreviations intact",
    splitSentences("Dr. Smith arrived at 3.30 p.m. He was late.").length === 2,
    `got ${splitSentences("Dr. Smith arrived at 3.30 p.m. He was late.").length}`,
  );
  check("does not split on decimal numbers", splitSentences("It cost 4.50 today.").length === 1);

  // A segment must begin and end where the punctuation does. A closing mark
  // dropped onto the next segment is what made a two-word line of dialogue read
  // as a narration fragment with no subject.
  const segments = (text: string) => splitSentences(text).map((s) => s.trim());

  check(
    "keeps the closing quotation mark with the sentence it ends",
    JSON.stringify(segments(`"Yes," said Lee Soo-hyun. "I'm decided."`)) ===
      JSON.stringify([`"Yes," said Lee Soo-hyun.`, `"I'm decided."`]),
    JSON.stringify(segments(`"Yes," said Lee Soo-hyun. "I'm decided."`)),
  );
  check(
    "keeps a closing mark that follows an ellipsis",
    segments(`"Wait..."`)[0] === `"Wait..."`,
    JSON.stringify(segments(`"Wait..."`)),
  );
  check(
    "keeps a closing bracket with its sentence",
    segments("(She nodded.) Then he left.").length === 2,
    JSON.stringify(segments("(She nodded.) Then he left.")),
  );
  check(
    "does not split after a comma inside a quotation",
    segments(`"Fine," Minjun said.`).length === 1,
    JSON.stringify(segments(`"Fine," Minjun said.`)),
  );
  check(
    "treats dotted abbreviations as one word",
    segments("It took e.g. ten minutes.").length === 1,
    JSON.stringify(segments("It took e.g. ten minutes.")),
  );
  check(
    "protects titles with several initials",
    segments("J. R. R. Tolkien wrote it. She agreed.").length === 2,
    JSON.stringify(segments("J. R. R. Tolkien wrote it. She agreed.")),
  );
  check(
    "keeps decimal values with a trailing period inside a sentence",
    segments("She said it was 3.5 miles away and it took e.g. ten minutes.").length === 1,
    JSON.stringify(segments("She said it was 3.5 miles away and it took e.g. ten minutes.")),
  );
  check(
    "splits each line of a run of dialogue",
    segments(`"I go now."\n"You decided too fast."`).length === 2,
    JSON.stringify(segments(`"I go now."\n"You decided too fast."`)),
  );
  check(
    "keeps each line of a run of dialogue, splitting the two sentences inside it",
    JSON.stringify(segments(`"I go now."\n"You decided it very quick. It has been only three days."`)) ===
      JSON.stringify([`"I go now."`, `"You decided it very quick.`, `It has been only three days."`]),
    JSON.stringify(segments(`"I go now."\n"You decided it very quick. It has been only three days."`)),
  );
  check(
    "splits on a blank line between paragraphs",
    segments("The hall was dark.\n\nShe opened the door.").length === 2,
    JSON.stringify(segments("The hall was dark.\n\nShe opened the door.")),
  );
  check(
    "loses no text: the segments rejoin to the input",
    (() => {
      const text = `Dr. Smith went to Washington.\n\n"Yes," said Lee. "I am decided."\n"You decided too fast."\n\nIt cost 3.5 million won, e.g. in taxes.`;
      return splitSentences(text).join("") === text;
    })(),
  );

  check("counts words in a sentence", countWords("the quick brown fox") === 4);
  check(
    "simple prose scores as easy",
    readabilityOf("The cat sat on the mat. It was warm.").score > 80,
    `score was ${readabilityOf("The cat sat on the mat. It was warm.").score}`,
  );
  check("empty text has no readability claim", readabilityOf("").label === "—");

  // ---------------------------------------------------------- local engine
  section("local-engine");

  const messy =
    "It were a quiet morning.  She had recieved the letter and it was not good. " +
    "The the dog barked loudly and she could not think. she was very very tired.";

  const faithful = correctLocally(messy, "faithful", [...ISSUE_CATEGORIES]);

  check("fixes double comparative", faithful.corrected.includes("It was"), faithful.corrected);
  check("collapses the doubled article", !faithful.corrected.includes("the the"));
  check("contracts a negation", faithful.corrected.includes("couldn't"));
  check("produces suggestions", faithful.suggestions.length > 0);
  check(
    "every suggestion has a distinct id",
    new Set(faithful.suggestions.map((item) => item.id)).size === faithful.suggestions.length,
  );
  check(
    "summary counts words",
    faithful.summary.wordCount === countWords(faithful.corrected),
    `summary=${faithful.summary.wordCount} actual=${countWords(faithful.corrected)}`,
  );
  check(
    "category counts match the suggestion list",
    Object.values(faithful.summary.issuesByCategory).reduce(
      (sum, value) => sum + (value ?? 0),
      0,
    ) === faithful.suggestions.length,
  );

  const concise = correctLocally(messy, "concise", [...ISSUE_CATEGORIES]);
  check(
    "concise tone is no longer than faithful",
    concise.corrected.length <= faithful.corrected.length,
  );
  check("concise cuts intensifiers", !/\bvery\b/i.test(concise.corrected), concise.corrected);

  const empty = correctLocally("", "polished", [...ISSUE_CATEGORIES]);
  check("empty input is handled without throwing", empty.corrected === "");
  check("empty input yields no suggestions", empty.suggestions.length === 0);

  const longSentenceText =
    "The man walked to the door and opened it and looked out at the long grey street " +
    "where the rain was falling hard on the stones and the wind was cold and he thought " +
    "about everything that had happened to him since the winter without really knowing " +
    "what he should do about any of it at all.";

  const longSentence = correctLocally(longSentenceText, "faithful", ["structure"]);
  check(
    "flags an overlong sentence under the structure category",
    longSentence.suggestions.some((item) => item.category === "structure"),
  );

  const quietStructure = correctLocally(longSentenceText, "faithful", ["grammar"]);
  check(
    "withholds structure notes when that category is off",
    quietStructure.suggestions.every((item) => item.category !== "structure"),
  );

  // ---------------------------------------------------------- model output
  section("model-output");

  const parsed = parseModelOutput(
    JSON.stringify({
      corrected: "A clean sentence.",
      suggestions: [
        { category: "grammar", title: "Fix tense", original: "It were", suggestion: "It was" },
        { category: "nonsense", title: "Bad category", original: "a", suggestion: "b" },
        { category: "clarity", title: "No replacement" },
      ],
    }),
  );

  check("reads the corrected text", parsed.corrected === "A clean sentence.");
  // Entry 2 has a usable original/replacement so it survives, with its bad
  // category coerced. Entry 3 has no replacement and is dropped entirely.
  check("keeps both suggestions that have a replacement", parsed.suggestions.length === 2);
  check(
    "falls back to grammar for an unknown category",
    parsed.suggestions[1]?.category === "grammar",
  );
  check(
    "drops entries with no suggested replacement",
    !parsed.suggestions.some((item) => item.title === "No replacement"),
  );
  check(
    "tolerates a fenced JSON response",
    parseModelOutput('```json\n{"corrected":"x","suggestions":[]}\n```').corrected === "x",
  );

  let threw = false;
  try {
    parseModelOutput("not json at all");
  } catch (error) {
    threw = error instanceof LlmError;
  }
  check("rejects non-JSON output with an LlmError", threw);

  threw = false;
  try {
    parseModelOutput(JSON.stringify({ suggestions: [] }));
  } catch {
    threw = true;
  }
  check("rejects output with no corrected text", threw);

  // ----------------------------------------------------------- validation
  section("request-validation");

  check("rejects blank text", "error" in validateRequest({ text: "   " }));
  check("rejects oversized text", "error" in validateRequest({ text: "a".repeat(60_001) }));
  check("rejects a non-object body", "error" in validateRequest("nope"));

  const good = validateRequest({
    text: "Hello there.",
    tone: "concise",
    categories: ["grammar", "bogus"],
  });
  check("accepts a valid request", !("error" in good));
  if (!("error" in good)) {
    check("honours a known tone", good.tone === "concise");
    check(
      "drops unknown categories",
      good.categories.length === 1 && good.categories[0] === "grammar",
    );
  }

  const defaulted = validateRequest({ text: "Hello there.", tone: "nonsense" });
  check(
    "defaults an unknown tone to polished",
    !("error" in defaulted) && defaulted.tone === "polished",
  );

  const noCategories = validateRequest({ text: "Hello there." });
  check(
    "defaults missing categories to an empty list",
    !("error" in noCategories) && noCategories.categories.length === 0,
  );

  const povDefault = validateRequest({ text: "Hello there." });
  check(
    "defaults the POV mode to detect",
    !("error" in povDefault) && povDefault.povMode === "detect",
  );

  const povKnown = validateRequest({ text: "Hello there.", povMode: "enforce" });
  check(
    "honours a known POV mode",
    !("error" in povKnown) && povKnown.povMode === "enforce",
  );

  const povUnknown = validateRequest({ text: "Hello there.", povMode: "sideways" });
  check(
    "falls back from an unknown POV mode",
    !("error" in povUnknown) && povUnknown.povMode === "detect",
  );

  // -------------------------------------------------------------------- pov
  section("pov");

  const tagged = analysePov('"I should go," Sarah said.', "detect");
  check("reads a tag after the quote", tagged.speakers[0]?.speaker === "Sarah");
  check("marks the basis as a tag", tagged.speakers[0]?.basis === "tag");

  const beforeTag = analysePov('Sarah said, "I should go."', "detect");
  check("reads a tag before the quote", beforeTag.speakers[0]?.speaker === "Sarah");

  // `"Don't," she said` once resolved to "Don" because the lookbehind window
  // ran back through the opening quote and read the contraction as a name.
  const apostrophe = analysePov(
    `Sarah's hand shook. She didn't look at him. "Don't," she said.`,
    "detect",
  );
  check("a contraction is not a speaker name", apostrophe.speakers[0]?.speaker === "Sarah");

  const possessive = analysePov(`"Are you coming?" Sarah's voice was low.`, "detect");
  check(
    "a possessive is not a speaker name",
    possessive.speakers[0]?.speaker !== "Sarah's",
  );

  const beat = analysePov(
    `Sarah set down her cup.\n"You always do this,"\nMaria did not look up.`,
    "detect",
  );
  check("falls back to the following beat", beat.speakers[0]?.speaker === "Maria");

  // A previous line's trailing tag sits in the gap before this line's quote.
  // Reading it as this line's tag would both misattribute the line and suppress
  // the repeated-tag finding that the Korean-webnovel case depends on.
  const korean = `"I'm fine," Minjun said.\n"No, you're not," Minjun said.\n"Fine. Whatever." Minjun said.`;
  const koreanResult = analysePov(korean, "enforce");
  check(
    "attributes every line to the same speaker",
    koreanResult.speakers.every((note) => note.speaker === "Minjun"),
    JSON.stringify(koreanResult.speakers.map((note) => note.speaker)),
  );
  check(
    "flags the repeated tag on the second and third lines",
    koreanResult.speakers.filter((note) => note.fix).length === 2,
  );
  check(
    "keeps the first tag as the reader's anchor",
    koreanResult.speakers[0]?.fix === undefined,
  );

  const applied = applyPovFixes(korean, koreanResult.speakers);
  check(
    "removing the repeats leaves the first tag",
    applied.startsWith(`"I'm fine," Minjun said.`),
    applied,
  );
  check(
    "removing the repeats leaves no empty tags",
    (applied.match(/Minjun said\./g) ?? []).length === 1,
    applied,
  );
  check(
    "a line that ended on a comma gains a full stop",
    applied.includes(`"No, you're not."`),
    applied,
  );
  check(
    "a line that already ended in a full stop does not gain a second",
    applied === `"I'm fine," Minjun said.\n"No, you're not."\n"Fine. Whatever."`,
    applied,
  );
  check(
    "every line survives the rewrite",
    applied.split("\n").length === 3 && (applied.match(/"/g) ?? []).length === 6,
    applied,
  );

  const detectOnly = analysePov(korean, "detect");
  check(
    "detect mode reports the repeat without proposing a fix",
    detectOnly.speakers.every((note) => note.fix === undefined) &&
      detectOnly.suggestions.length > 0,
  );

  const off = analysePov(korean, "off");
  check("off mode returns no speakers", off.speakers.length === 0 && off.suggestions.length === 0);

  const unattributed = analysePov(
    `"Are you coming?"\n"Give me a minute."\n"I am busy."\n"Then go."`,
    "detect",
  );
  check(
    "reports a long run of unattributed dialogue",
    unattributed.suggestions.some((item) => item.title === "Long run of unattributed dialogue"),
  );

  const noDialogue = analysePov("It were a quiet morning in Ashford.", "detect");
  check("narration with no dialogue yields no lines", noDialogue.speakers.length === 0);

  const extraction = extractDialogue('He said "hello there" and left.');
  check("extracts one quoted line", extraction.length === 1);
  check(
    "records the quote offsets",
    extraction[0]?.start === 8 && extraction[0]?.end === 21,
    JSON.stringify(extraction[0]),
  );

  // ------------------------------------------------------------ local engine
  section("local-engine with pov");

  const engineResult = correctLocally(korean, "polished", [...ISSUE_CATEGORIES], "enforce");
  check(
    "the engine applies POV fixes on the enforce path",
    engineResult.corrected === applied,
    engineResult.corrected,
  );
  check("the engine reports speakers", engineResult.speakers.length === 3);
  check(
    "the engine reports the POV category",
    engineResult.suggestions.some((item) => item.category === "pov"),
  );

  const engineOff = correctLocally(korean, "polished", [...ISSUE_CATEGORIES], "off");
  check("the engine skips POV when off", engineOff.speakers.length === 0);
  check(
    "the engine leaves the text alone when off",
    engineOff.corrected === korean,
    engineOff.corrected,
  );

  // The pasted chapter is the source of truth and is never rewritten by the
  // caller, so the corrected text must still contain every original line.
  const localKeep = correctLocally(
    `"I am fine," Minjun said.\n"No, you're not," Minjun said.`,
    "polished",
    [...ISSUE_CATEGORIES],
    "enforce",
  );
  check(
    "no dialogue is dropped from the improved text",
    (localKeep.corrected.match(/"/g) ?? []).length === 4,
    localKeep.corrected,
  );

  // ------------------------------------------------------- continuity layer
  section("story bible");

  const bible = defaultBible();
  const phine = bible.entries.find((entry) => entry.name === "Phine");

  check("the shipped dictionary loads", bible.entries.length >= 13, String(bible.entries.length));
  check(
    "the dictionary carries the alias chain",
    Boolean(phine && phine.aliases.includes("Phine Grancia") && phine.aliases.includes("Mardol")),
    JSON.stringify(phine?.aliases),
  );
  check(
    "the dictionary records a gender",
    phine?.gender === "female" && bible.entries.find((e) => e.name === "Licht")?.gender === "male",
  );
  check(
    "locations and organisations are typed apart from characters",
    bible.entries.find((e) => e.name === "Temple of Tarden")?.kind === "location" &&
      bible.entries.find((e) => e.name === "Heroic Cult")?.kind === "organisation" &&
      bible.entries.find((e) => e.name === "Giyu")?.kind === "term",
  );

  const prompt = formatBibleForPrompt(bible);
  check(
    "the dictionary renders into the prompt",
    prompt.includes("STORY CONTINUITY DICTIONARY") && prompt.includes("- Phine (female) = Phine Grancia = Mardol"),
    prompt.slice(0, 120),
  );
  check("an empty dictionary renders nothing", formatBibleForPrompt({ entries: [] }) === "");
  check("a missing dictionary renders nothing", formatBibleForPrompt(undefined) === "");

  // The case the workflow document calls out: a transliteration variant that
  // continuity settles, so the editor does not read it as a new character.
  const normalised = normaliseNames("Mardol raised her glass mask.", bible);
  check(
    "a known alias is rewritten to its canonical name",
    normalised.text === "Phine raised her glass mask.",
    normalised.text,
  );
  check(
    "the rename is reported, never silent",
    normalised.notes.length === 1 && normalised.notes[0].raw === "Mardol" && normalised.notes[0].canonical === "Phine",
    JSON.stringify(normalised.notes),
  );

  check(
    "a canonical name is left exactly as written",
    normaliseNames("Licht sheathed Giyu.", bible).text === "Licht sheathed Giyu.",
  );
  check(
    "an unknown name is left alone",
    normaliseNames("Brannoc waited by the gate.", bible).text === "Brannoc waited by the gate.",
  );
  check(
    "an ordinary English word is never read as a name",
    normaliseNames("She was fine. The old man smiled.", bible).text === "She was fine. The old man smiled.",
  );
  check(
    "shouting keeps its case",
    normaliseNames("MARDOL TURNED.", bible).text === "PHINE TURNED.",
    normaliseNames("MARDOL TURNED.", bible).text,
  );

  const found = findContinuityNotes("Phine crossed the Temple of Tarden with Giyu at her hip.", bible);
  check(
    "a canonical name is reported as matched",
    found.length === 3 && found.every((note) => note.raw === note.canonical),
    JSON.stringify(found.map((note) => note.raw)),
  );
  check(
    "a match inside a quotation shows the whole line",
    found.every((note) => !note.context?.startsWith('" ') && !note.context?.startsWith("Fine")),
    JSON.stringify(found.map((note) => note.context)),
  );
  check("an empty chapter matches nothing", findContinuityNotes("", bible).length === 0);

  // A note that only repeats the name already on the row is left empty.
  const bareBible: StoryBible = normaliseBible([
    { id: "b1", kind: "character", name: "Selena" },
  ]);
  check(
    "an entry with no gender or role carries no note",
    findContinuityNotes("Selena smiled.", bareBible).every((note) => !note.note),
    JSON.stringify(findContinuityNotes("Selena smiled.", bareBible)),
  );
  const described = findContinuityNotes(
    "Kainel waited.",
    normaliseBible([{ id: "b2", kind: "character", name: "Kainel", gender: "male", role: "Hero" }]),
  );
  check(
    "an entry with a role describes itself",
    described[0]?.note === "Kainel (male, Hero)",
    JSON.stringify(described[0]?.note),
  );

  const sectioned = parseBibleText(`PROJECT CONTINUITY DICTIONARY

CHARACTERS:
Phine: female = Phine Grancia = Mardol; Glass Knight
Kainel: male; Hero; Ariel's childhood friend/love interest

LOCATIONS:
Temple of Tarden

ORGANISATIONS:
Heroic Cult
Giyu: Licht's personal sword`);

  const parsedPhine = sectioned.entries.find((entry) => entry.name === "Phine");
  const parsedKainel = sectioned.entries.find((entry) => entry.name === "Kainel");
  const parsedGiyu = sectioned.entries.find((entry) => entry.name === "Giyu");

  check("a pasted dictionary parses every line", sectioned.entries.length === 5, String(sectioned.entries.length));
  check(
    "a pasted line keeps its aliases and drops the gender from them",
    parsedPhine?.gender === "female" &&
      parsedPhine.aliases.length === 2 &&
      parsedPhine.aliases.includes("Mardol") &&
      parsedPhine.role === "Glass Knight",
    JSON.stringify(parsedPhine),
  );
  check(
    "a leading gender token is read as the gender, not the role",
    parsedKainel?.gender === "male" && (parsedKainel?.role ?? "").startsWith("Hero"),
    JSON.stringify(parsedKainel),
  );
  check(
    "a heading types the lines beneath it",
    parsedGiyu?.kind === "term" &&
      sectioned.entries.find((entry) => entry.name === "Temple of Tarden")?.kind === "location" &&
      sectioned.entries.find((entry) => entry.name === "Heroic Cult")?.kind === "organisation",
  );
  // A line of ordinary prose has no colon and is not a heading, so it is
  // rejected rather than turned into a character with a nonsense role.
  check("a pasted dictionary that is only prose parses to nothing", parseBibleText("just a sentence").entries.length === 0);
  check(
    "a prose line with a colon is not mistaken for an entry",
    parseBibleText("Note: the passage below is unfinished.").entries.length === 0,
  );

  check(
    "a malformed dictionary is dropped rather than trusted",
    normaliseBible({ entries: [{ name: "  " }, { name: "Ariel", kind: "nonsense" }, null, 7] }).entries
      .length === 1,
  );
  const noDictionary = validateRequest({ text: "Hello." });
  check(
    "a missing dictionary validates as empty",
    !("error" in noDictionary) && noDictionary.storyBible.entries.length === 0,
    JSON.stringify(noDictionary),
  );

  // ------------------------------------------------------------ model output
  section("model output continuity");

  const withContinuity = parseModelOutput(
    JSON.stringify({
      corrected: "A polished line.",
      suggestions: [],
      continuity: [
        { raw: "Fine", canonical: "Phine", note: "Only Phine answers." },
        { canonical: "Phine" },
        { raw: "Fine" },
        "nonsense",
      ],
    }),
  );
  check(
    "continuity notes need both a variant and a canonical name",
    withContinuity.continuity.length === 1 &&
      withContinuity.continuity[0].raw === "Fine" &&
      withContinuity.continuity[0].canonical === "Phine",
    JSON.stringify(withContinuity.continuity),
  );
  check(
    "a response with no continuity key still parses",
    parseModelOutput(JSON.stringify({ corrected: "Line.", suggestions: [] })).continuity.length === 0,
  );

  // ---------------------------------------------------------------- pipeline
  section("pipeline report");

  const povForReport = analysePov("You are late.", "detect");
  const report = buildPipelineReport({
    original: "You are late.",
    corrected: "You are late.",
    suggestions: [],
    speakers: povForReport?.speakers ?? [],
    continuity: found,
    summary: {
      wordCount: 3,
      sentenceCount: 1,
      averageSentenceLength: 3,
      readability: readabilityOf("You are late."),
      issuesByCategory: {},
    },
    bible,
    povMode: "detect",
    engine: "rules",
  });

  check("the report covers all ten stages", report.length === PIPELINE_STAGES.length, String(report.length));
  check(
    "the stages are in the documented order",
    report.map((entry) => entry.stage).join(",") === PIPELINE_STAGES.join(","),
  );
  check(
    "a stage says what it found",
    report.find((entry) => entry.stage === "normalize")?.detail?.includes("3 names") === true,
    report.find((entry) => entry.stage === "normalize")?.detail,
  );
  check(
    "a stage never claims a rewrite that did not happen",
    report.find((entry) => entry.stage === "rewrite")?.detail?.includes("no change") === true,
    report.find((entry) => entry.stage === "rewrite")?.detail,
  );
  const renameReport = buildPipelineReport({
    original: "Mardol lifted her glass mask.",
    corrected: "Phine lifted her glass mask.",
    suggestions: [],
    speakers: [],
    continuity: [
      { raw: "Mardol", canonical: "Phine", via: "Mardol", context: "Mardol lifted her glass mask." },
    ],
    summary: {
      wordCount: 6,
      sentenceCount: 1,
      averageSentenceLength: 6,
      readability: readabilityOf("Mardol lifted her glass mask."),
      issuesByCategory: {},
    },
    bible,
    povMode: "detect",
    engine: "rules",
  });

  check(
    "the continuity stage names the variant it resolved",
    renameReport.find((entry) => entry.stage === "continuity")?.detail?.includes("Mardol") === true,
    renameReport.find((entry) => entry.stage === "continuity")?.detail,
  );
  check(
    "a chapter with only canonical names reports no drift",
    report.find((entry) => entry.stage === "continuity")?.detail === "No alias or identity drift found.",
    report.find((entry) => entry.stage === "continuity")?.detail,
  );

  const offReport = buildPipelineReport({
    original: "Plain narration.",
    corrected: "Plain narration.",
    suggestions: [],
    speakers: [],
    continuity: [],
    summary: {
      wordCount: 2,
      sentenceCount: 1,
      averageSentenceLength: 2,
      readability: readabilityOf("Plain narration."),
      issuesByCategory: {},
    },
    povMode: "off",
    engine: "rules",
  });
  check(
    "a stage that was turned off says so",
    offReport.find((entry) => entry.stage === "pov")?.ran === false,
  );

  // ----------------------------------------------------------------- report
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runEngineTests();
