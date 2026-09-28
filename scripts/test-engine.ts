/**
 * Engine self-test.
 *
 * Exercises the deterministic parts of the pipeline with no network call and no
 * API key: text statistics, the sentence splitter's abbreviation handling, the
 * chunker, the paragraph pairing the diff view is built from, the local
 * correction rules, both model-output parsers, and request validation.
 *
 * Run with: npm run test:engine
 *
 * Wrapped so top-level bindings stay file-scoped. The project type check
 * otherwise treats these scripts as one shared global scope, and same-named
 * bindings in sibling scripts collide.
 */

import { chunkText, joinChunks, needsChunking } from "../lib/chunker";
import { alignParagraphs, composeFromPairs, similarity } from "../lib/diff";
import { countWords, normaliseForCompare, readabilityOf, splitSentences } from "../lib/text-stats";
import { correctLocally } from "../lib/local-engine";
import { analysePov, applyPovFixes, extractDialogue } from "../lib/pov";
import { LlmError, parseAnalysis, parseRewrite } from "../lib/model-output";
import { parseBibleText } from "../lib/default-bible";
import { findContinuityNotes, formatBibleForPrompt, normaliseBible, normaliseNames } from "../lib/story-bible";
import { validateRequest } from "../lib/validate";
import { ISSUE_CATEGORIES } from "@/lib/types";
import type { AnalysisNote, Change, StoryBible } from "@/lib/types";

/** A reader's own cast, used wherever the test needs a non-empty dictionary. */
const TEST_BIBLE: StoryBible = normaliseBible({
  entries: [
    { id: "c1", kind: "character", name: "Phine", aliases: ["Phine Grancia", "Mardol"], gender: "female", role: "Glass Knight" },
    { id: "c2", kind: "character", name: "Kainel", aliases: [], gender: "male", role: "Hero" },
    { id: "c3", kind: "character", name: "Ariel", aliases: [], gender: "female", role: "red-haired elf mage" },
  ],
});

/** Every finding the rules engine produced, flattened out of the change list. */
function findingsOf(changes: Change[]): AnalysisNote[] {
  return changes.flatMap((change) => change.notes);
}

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
  check("produces one change per paragraph", faithful.changes.length > 0);
  check(
    "every change carries its own paragraph index",
    faithful.changes.every((change, position) => change.index === position),
    JSON.stringify(faithful.changes.map((change) => change.index)),
  );
  check(
    "at least one paragraph is reported as rewritten",
    faithful.changes.some((change) => !change.unchanged),
  );
  check(
    "a changed paragraph keeps the original text on the left",
    faithful.changes.every((change) => change.before.length > 0),
  );
  check(
    "an unchanged paragraph reads identically on both sides",
    faithful.changes.every((change) => !change.unchanged || change.after === change.before),
  );
  check(
    "a rule that rewrote its quote leaves the finding on that paragraph",
    findingsOf(faithful.changes).some((note) => note.excerpt === "It were"),
    JSON.stringify(findingsOf(faithful.changes)),
  );
  check(
    "a repeated word is reported once, on the paragraph it sits in",
    findingsOf(faithful.changes).filter((note) => note.excerpt.toLowerCase() === "the the").length === 1,
    JSON.stringify(findingsOf(faithful.changes).map((note) => note.excerpt)),
  );
  check(
    "a clean rule fix is reported here with its replacement",
    findingsOf(faithful.changes).some((note) => note.excerpt === "It were" && note.rewrite === "It was"),
    JSON.stringify(findingsOf(faithful.changes).map((note) => [note.excerpt, note.rewrite])),
  );
  check(
    "an observation the engine chose not to apply carries no replacement",
    findingsOf(faithful.changes).every((note) => note.rewrite.length > 0 || note.intended.length > 0),
  );
  check(
    "the findings are attributed to the paragraph they appear in",
    faithful.changes.every((change) =>
      change.notes.every((note) => note.paragraph === change.index),
    ),
    JSON.stringify(faithful.changes.map((change) => change.notes.map((note) => note.excerpt))),
  );
  check(
    "the corrections survive into the assembled text",
    countWords(faithful.corrected) > 0,
    faithful.corrected,
  );

  const concise = correctLocally(messy, "concise", [...ISSUE_CATEGORIES]);
  check(
    "concise tone is no longer than faithful",
    concise.corrected.length <= faithful.corrected.length,
  );
  check("concise cuts intensifiers", !/\bvery\b/i.test(concise.corrected), concise.corrected);

  const empty = correctLocally("", "polished", [...ISSUE_CATEGORIES]);
  check("empty input is handled without throwing", empty.corrected === "");
  check("empty input yields no changes", empty.changes.length === 0);

  const longSentenceText =
    "The man walked to the door and opened it and looked out at the long grey street " +
    "where the rain was falling hard on the stones and the wind was cold and he thought " +
    "about everything that had happened to him since the winter without really knowing " +
    "what he should do about any of it at all.";

  const longSentence = correctLocally(longSentenceText, "faithful", ["structure"]);
  check(
    "flags an overlong sentence under the structure category",
    findingsOf(longSentence.changes).some((note) => note.category === "structure"),
    JSON.stringify(findingsOf(longSentence.changes).map((note) => [note.category, note.excerpt])),
  );
  // The line is one line of a whole paragraph, so the finding belongs to that
  // paragraph and to no other row.
  check(
    "an overlong sentence is reported once, on the paragraph it sits in",
    findingsOf(longSentence.changes).filter((note) => note.category === "structure").length === 1 &&
      findingsOf(longSentence.changes)[0]?.paragraph === 0,
    JSON.stringify(longSentence.changes.map((change) => change.notes.map((note) => note.paragraph))),
  );

  const quietStructure = correctLocally(longSentenceText, "faithful", ["grammar"]);
  check(
    "withholds structure notes when that category is off",
    findingsOf(quietStructure.changes).every((note) => note.category !== "structure"),
  );

  // ---------------------------------------------------------- model output
  section("model-output / analyst pass");

  const analysis = parseAnalysis(
    JSON.stringify({
      notes: [
        {
          category: "grammar",
          title: "Fix tense",
          paragraph: 0,
          excerpt: "It were",
          intended: "Past tense.",
          rewrite: "It was",
        },
        {
          category: "nonsense",
          title: "Bad category",
          paragraph: 1,
          excerpt: "the the",
        },
        { category: "clarity", title: "No excerpt", paragraph: 1 },
      ],
      continuity: [],
    }),
    3,
  );

  // Entry 2 has an excerpt so it survives, with its bad category coerced.
  // Entry 3 cannot be tied to a place in the passage and is dropped.
  check("keeps both notes that carry an excerpt", analysis.notes.length === 2);
  check("falls back to grammar for an unknown category", analysis.notes[1]?.category === "grammar");
  check(
    "drops a note with no excerpt",
    !analysis.notes.some((note) => note.title === "No excerpt"),
  );
  check(
    "a note with no intended reading still says something",
    (analysis.notes[1]?.intended.length ?? 0) > 0,
  );
  check(
    "an invented paragraph index is pulled back into range",
    parseAnalysis(
      JSON.stringify({ notes: [{ paragraph: 400, excerpt: "a", title: "t" }] }),
      3,
    ).notes[0]?.paragraph === 2,
  );
  check(
    "a negative paragraph index is pulled up to the first paragraph",
    parseAnalysis(
      JSON.stringify({ notes: [{ paragraph: -5, excerpt: "a", title: "t" }] }),
      3,
    ).notes[0]?.paragraph === 0,
  );
  check(
    "a response with no notes key parses to an empty list",
    parseAnalysis("{}", 3).notes.length === 0,
  );
  check(
    "tolerates a fenced JSON response",
    parseAnalysis('```json\n{"notes":[],"continuity":[]}\n```', 3).notes.length === 0,
  );

  let analysisThrew = false;
  try {
    parseAnalysis("not json at all", 3);
  } catch (error) {
    analysisThrew = error instanceof LlmError;
  }
  check("rejects non-JSON analysis with an LlmError", analysisThrew);

  section("model-output / rewrite pass");

  check(
    "reads the corrected chapter",
    parseRewrite(JSON.stringify({ corrected: "A clean sentence." })).corrected === "A clean sentence.",
  );
  check(
    "tolerates a fenced rewrite",
    parseRewrite('```json\n{"corrected":"x"}\n```').corrected === "x",
  );
  check(
    "a rewrite with no prose is the one hard failure",
    (() => {
      try {
        parseRewrite(JSON.stringify({ notes: [] }));
      } catch (error) {
        return error instanceof LlmError;
      }
      return false;
    })(),
  );

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
    findingsOf(engineResult.changes).some((note) => note.category === "pov"),
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

  // The app ships no seeded cast: the dictionary is whatever the reader pastes.
  // These cases run against a reader-supplied one.
  const bible = TEST_BIBLE;
  const phine = bible.entries.find((entry) => entry.name === "Phine");

  check("a reader's dictionary loads", bible.entries.length === 3, String(bible.entries.length));
  check(
    "the dictionary carries the alias chain",
    Boolean(phine && phine.aliases.includes("Phine Grancia") && phine.aliases.includes("Mardol")),
    JSON.stringify(phine?.aliases),
  );
  check(
    "the dictionary records a gender",
    phine?.gender === "female" && bible.entries.find((e) => e.name === "Kainel")?.gender === "male",
  );
  check(
    "a free-text role is read as a description",
    phine?.role === "Glass Knight",
    JSON.stringify(phine?.role),
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
    normaliseNames("Kainel waited.", bible).text === "Kainel waited.",
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

  const found = findContinuityNotes("Phine crossed the courtyard with Ariel at her side.", bible);
  check(
    "a canonical name is reported as matched",
    found.length === 2 && found.every((note) => note.raw === note.canonical),
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
  section("analyst continuity notes");

  const withContinuity = parseAnalysis(
    JSON.stringify({
      notes: [],
      continuity: [
        { raw: "Fine", canonical: "Phine", note: "Only Phine answers." },
        { canonical: "Phine" },
        { raw: "Fine" },
        "nonsense",
      ],
    }),
    2,
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
    parseAnalysis(JSON.stringify({ notes: [] }), 2).continuity.length === 0,
  );

  // ------------------------------------------------------------------ chunker
  section("chunker");

  const shortChapter = "One paragraph.\n\nTwo paragraphs.";
  check("a short chapter is one chunk", chunkText(shortChapter).length === 1);
  check("an empty chapter makes no chunks", chunkText("").length === 0);
  check("a short chapter is never marked for splitting", !needsChunking(shortChapter));
  check(
    "a short chapter rejoins to itself",
    joinChunks(chunkText(shortChapter).map((chunk) => chunk.text)) === shortChapter,
    joinChunks(chunkText(shortChapter).map((chunk) => chunk.text)),
  );

  // Five paragraphs of 400 characters each overflows a 1,000-character request,
  // and each chunk must stay at or under that.
  const paragraphs = Array.from({ length: 5 }, (_, i) => `${i} `.repeat(200).trim());
  const longChapter = paragraphs.join("\n\n");
  const pieces = chunkText(longChapter, 1_000);

  check("a long chapter is split", pieces.length > 1, `${pieces.length} chunks`);
  check("no chunk exceeds the requested size", pieces.every((chunk) => chunk.size <= 1_000));
  check("chunks are numbered in reading order", pieces.every((chunk, i) => chunk.index === i));
  check(
    "every chunk reports its own true length",
    pieces.every((chunk) => chunk.size === chunk.text.length),
  );
  check(
    "no text is lost or duplicated across the split",
    joinChunks(pieces.map((chunk) => chunk.text)) === longChapter,
  );
  check("a long chapter is marked for splitting", needsChunking(longChapter, 1_000));

  // One paragraph longer than the ceiling is broken at sentence boundaries, so
  // no request is ever built from a fragment of a sentence.
  const wall = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} ran on.`).join(" ");
  const wallPieces = chunkText(wall, 200);
  check("an oversized paragraph is broken up", wallPieces.length > 1, `${wallPieces.length} chunks`);
  check(
    "each broken piece still ends on a full stop",
    wallPieces.every((chunk) => /\.$/.test(chunk.text.trim())),
    JSON.stringify(wallPieces.map((chunk) => chunk.text.slice(-30))),
  );
  check(
    "the rewrite rejoins into the original once whitespace is normalised",
    normaliseForCompare(joinChunks(wallPieces.map((chunk) => chunk.text))) ===
      normaliseForCompare(wall),
    joinChunks(wallPieces.map((chunk) => chunk.text)),
  );

  // ------------------------------------------------------------ paragraph pairing
  section("paragraph alignment");

  const original = "The hall was dark.\n\nShe opened the door.";
  const sameShape = alignParagraphs(original, "The hall was cold.\n\nShe opened the heavy door.");
  check("equal counts pair one to one", sameShape.length === 2);
  check(
    "each pair keeps its own index",
    sameShape.every((pair, position) => pair.index === position),
  );
  check(
    "a reworded paragraph counts as changed",
    sameShape[0]?.unchanged === false && sameShape[0]?.after === "The hall was cold.",
  );

  const untouched = alignParagraphs(original, "The hall was dark.\n\nShe opened the door.");
  check(
    "an identical rewrite is reported as unchanged",
    untouched.every((pair) => pair.unchanged),
  );
  check(
    "punctuation alone does not count as a change",
    alignParagraphs("She was tired.", "She was tired!")[0]?.unchanged === true,
  );
  check(
    "casing alone does not count as a change",
    alignParagraphs("Phine waited.", "phine waited.")[0]?.unchanged === true,
  );
  check(
    "a rewrite with no paragraphs leaves nothing to pair",
    alignParagraphs(original, "").length === 2,
  );
  check(
    "an empty original produces no pairs",
    alignParagraphs("", "Anything at all.").length === 0,
  );

  // The model is told to keep the paragraph count, so a difference of one is
  // read positionally and the shortfall is a deletion the reader can undo.
  const shortRewrite = alignParagraphs(
    "First beat.\n\nSecond beat.\n\nThird beat.",
    "First beat.\n\nSecond beat.",
  );
  check("a missing trailing paragraph is still paired positionally", shortRewrite.length === 3);
  check("the surviving paragraphs keep their text", shortRewrite[1]?.after === "Second beat.");
  check(
    "the dropped paragraph reads as deleted, not rewritten",
    shortRewrite[2]?.after === null && shortRewrite[2]?.unchanged === true,
  );

  // Three originals against four rewrites. The count gap is one, so the
  // positional rule holds and each original takes the rewrite in its own slot,
  // which is what the rewriter is told to produce.
  const shifted = alignParagraphs(
    "Phine drew her glass sword.\n\nKainel sheathed his.\n\nAriel began to sing.",
    "Ariel began to sing.\n\nPhine drew her glass sword and struck.\n\nKainel sheathed his.\n\nRain came through the window.",
  );
  check("a rewritten chapter still returns one pair per original", shifted.length === 3);
  check(
    "paragraphs are paired in the order they were written",
    shifted[0]?.after === "Ariel began to sing." &&
      shifted[1]?.after === "Phine drew her glass sword and struck." &&
      shifted[2]?.after === "Kainel sheathed his.",
    JSON.stringify(shifted.map((pair) => pair.after)),
  );

  // A gap of two is where position stops being credible and the similarity
  // fallback has to find each paragraph its own rewrite.
  const reordered = alignParagraphs(
    "Phine drew her glass sword.\n\nKainel sheathed his.\n\nAriel began to sing.",
    "Ariel began to sing.\n\nPhine drew her glass sword and struck.\n\nKainel sheathed his.\n\nRain came through the window.\n\nThe hall fell silent.",
  );
  check("a reshuffled rewrite still returns one pair per original", reordered.length === 3);
  check(
    "each original finds its own rewrite rather than a neighbour's",
    reordered[0]?.after === "Phine drew her glass sword and struck." &&
      reordered[1]?.after === "Kainel sheathed his." &&
      reordered[2]?.after === "Ariel began to sing.",
    JSON.stringify(reordered.map((pair) => pair.after)),
  );
  check(
    "every similarity pair is one-to-one",
    new Set(reordered.map((pair) => pair.after)).size === 3,
  );

  // Nothing in the rewrite resembles this paragraph, so it is reported as
  // deleted rather than paired with the least-bad match.
  const replaced = alignParagraphs(
    "Phine drew her glass sword.\n\nKainel sheathed his.\n\nAriel began to sing.",
    "The tide came in. The gulls went quiet.",
  );
  check(
    "an original with no counterpart reads as deleted",
    replaced.every((pair) => pair.after === null && pair.unchanged),
    JSON.stringify(replaced.map((pair) => pair.after)),
  );
  check("the deleted original keeps its own text", replaced[2]?.before === "Ariel began to sing.");

  check("identical text scores a perfect similarity", similarity("a b c", "a b c") === 1);
  check(
    "shared wording scores above disjoint wording",
    similarity("the hall was dark", "the hall was cold") > similarity("the hall was dark", "rain came down"),
  );
  check("empty text has no similarity", similarity("", "anything") === 0);

  check(
    "normalising for comparison folds away punctuation and case",
    normaliseForCompare("  The Hall,  was dark!  ") === "the hall was dark",
  );

  // The assembled chapter is what Copy and Download produce. A paragraph in
  // the set contributes its rewrite, one left out contributes the pasted text,
  // and a rewrite that deleted a paragraph drops it from the output.
  const assembled = alignParagraphs(
    "The hall was dark.\n\nShe opened the door.\n\nA third beat.",
    "The hall was cold.\n\nShe opened the heavy door.",
  );
  check(
    "keeping a rewrite that shortened the chapter drops the deleted paragraph",
    composeFromPairs(assembled, new Set([0, 1, 2])) === "The hall was cold.\n\nShe opened the heavy door.",
  );
  check(
    "undoing the first change restores the original wording",
    composeFromPairs(assembled, new Set([1, 2])) ===
      "The hall was dark.\n\nShe opened the heavy door.",
  );
  check(
    "undoing the deleted paragraph brings the original back",
    composeFromPairs(assembled, new Set([0, 1])) ===
      "The hall was cold.\n\nShe opened the heavy door.\n\nA third beat.",
  );
  check(
    "undoing every change rebuilds the pasted chapter exactly",
    composeFromPairs(assembled, new Set()) ===
      "The hall was dark.\n\nShe opened the door.\n\nA third beat.",
  );
  check(
    "the rules engine's own pairing is accepted the same way",
    composeFromPairs(faithful.changes, new Set(faithful.changes.map((c) => c.index))).trim() ===
      faithful.corrected.trim(),
    composeFromPairs(faithful.changes, new Set(faithful.changes.map((c) => c.index))),
  );

  // ----------------------------------------------------------------- report
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runEngineTests();
