/**
 * Verifies the provider-backed path through /api/correct against a running
 * mock OpenAI-compatible server.
 *
 * The mock rejects any request that does not satisfy the prompt contract, so a
 * 200 here also proves the system prompt and payload shape are correct for both
 * passes.
 *
 * Run against the server started with LLM_BASE_URL pointed at the mock:
 *   bun run scripts/verify-llm-path.ts http://127.0.0.1:3001
 *
 * The body is wrapped in a uniquely-named function so its bindings stay
 * file-scoped. The project type check treats every `scripts/*.ts` file as one
 * shared global scope, so same-named bindings in sibling scripts collide.
 */

const MOCK = "http://127.0.0.1:4010";

async function verifyLlmPath() {
  const BASE = process.argv[2] || "http://127.0.0.1:3001";

  const SAMPLE = "It were a quiet morning. She had recieved the letter.";

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

  // The mock keeps its mode between runs, so reset it before the happy-path
  // checks. A leftover failure mode from a previous run would silently turn
  // these into fallback tests.
  async function setMode(mode: string) {
    const response = await fetch(`${MOCK}/__mock/mode?mode=${mode}`);
    const body = (await response.json()) as { mode: string };
    if (body.mode !== mode) throw new Error(`mock did not switch to "${mode}"`);
  }

  /**
   * The mock rejects a request whose dictionary presence disagrees with
   * LLM_MOCK_EXPECT_DICTIONARY, so this flag is set per call rather than per
   * run: it asserts what the engine actually sent, not just that it sent
   * something. It goes over HTTP because the flag is read inside the mock,
   * which is a different process from this one.
   */
  async function expectDictionary(expect: boolean) {
    await fetch(`${MOCK}/__mock/expect-dictionary?value=${expect ? "1" : "0"}`);
  }

  /** Tells the mock how many paragraphs the next paste has. */
  async function expectParagraphs(count: number) {
    await fetch(`${MOCK}/__mock/expect-paragraphs?value=${count}`);
  }

  /** Clears the request log so a check can read exactly one run's requests. */
  async function resetLog() {
    await fetch(`${MOCK}/__mock/reset`);
  }

  /** What the mock was actually asked, per pass. */
  async function lastRequests() {
    const body = (await (await fetch(`${MOCK}/__mock/last`)).json()) as {
      requests: Array<{ pass: string; model: string | null; temperature: number | null; bearer: string }>;
    };
    return body.requests;
  }

  async function correct(
    text: string,
    tone = "polished",
    povMode = "detect",
    storyBible?: unknown,
    model?: string,
  ) {
    const response = await fetch(`${BASE}/api/correct`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        tone,
        povMode,
        categories: [
          "grammar",
          "spelling",
          "clarity",
          "style",
          "repetition",
          "structure",
          "punctuation",
          "pov",
        ],
        ...(storyBible ? { storyBible } : {}),
        ...(model ? { model } : {}),
      }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  type Change = {
    index: number;
    before: string;
    after: string;
    unchanged: boolean;
    notes: Array<{ paragraph: number; category: string; title: string; excerpt: string; rewrite: string }>;
  };

  function changesOf(body: Record<string, unknown>): Change[] {
    return (body.changes as Change[]) ?? [];
  }

  function notesOf(body: Record<string, unknown>) {
    return changesOf(body).flatMap((change) => change.notes);
  }

  console.log("\nllm path");
  await setMode("ok");
  await expectDictionary(false);

  // The mock judges a request against the expectation its control endpoint was
  // last given, and a flag the endpoint fails to store is invisible until a
  // run is rejected for the wrong reason. Sending one shaped request each way
  // proves the flag is the only thing deciding the outcome.
  const shaped = await fetch(`${MOCK}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer self-check" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.3,
      messages: [
        { role: "system", content: "WEB-NOVEL STYLE. Return raw JSON only. No markdown fences, no commentary." },
        { role: "user", content: "PASSAGE:\nIt was a quiet morning." },
      ],
    }),
  });
  check("the mock accepts a request that carries no dictionary", shaped.status === 200, `status ${shaped.status}`);

  // The dictionary belongs to the analyst pass. The mock rejects an analyst
  // request that drops it while a dictionary is expected, and rejects one that
  // carries it when none is, so the flag is checked against the same pass in
  // both directions. Sending this against the rewriter would prove nothing: the
  // rewriter is handed the analyst's findings and never the raw dictionary.
  await expectDictionary(true);
  // The mock reads the pass off the system message and rejects an analyst
  // request that does not carry the analyst prompt at all, so the probe has to
  // look like a real analyst call. What is left out is the one thing under
  // test: the dictionary.
  const analystShape = {
    role: "system" as const,
    content: `EVIDENCE
When the text is unclear, treat the surrounding material as the evidence.
- Scene: what is physically happening?

OUTPUT
Return JSON with exactly these keys:
{
  "notes": [{ "paragraph": 0, "category": "grammar", "title": "t", "excerpt": "e", "intended": "i", "rewrite": "r" }],
  "continuity": [{ "raw": "a", "canonical": "b" }]
}

Return raw JSON only. No markdown fences, no commentary.`,
  };
  const withDictionary = await fetch(`${MOCK}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer self-check" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.3,
      messages: [
        analystShape,
        { role: "user", content: "PASSAGE:\nIt was a quiet morning." },
      ],
    }),
  });
  check(
    "the mock rejects an analyst request that drops the expected dictionary",
    withDictionary.status === 400,
    `status ${withDictionary.status}`,
  );
  await expectDictionary(false);

  const health = (await (await fetch(`${BASE}/api/health`)).json()) as {
    llm: {
      configured: boolean;
      model: string | null;
      defaultModel: string | null;
      provider: string | null;
      baseUrl: string | null;
      models: Array<{ id: string; label: string; note: string }>;
    };
  };

  check("health reports the provider as configured", health.llm.configured === true);
  check("health reports the configured model", health.llm.model === "gpt-4o-mini", `model=${health.llm.model}`);
  check(
    "health reports a default the picker can highlight",
    health.llm.defaultModel === "gpt-4o-mini",
    `defaultModel=${health.llm.defaultModel}`,
  );
  check("health offers the gpt models to the picker", health.llm.models.length >= 4, `models=${health.llm.models.length}`);
  check(
    "health offers no gemini models on an openai key",
    health.llm.models.every((model) => model.id.startsWith("gpt-")),
  );
  // The reasoning models reject a non-default temperature, so the transport
  // has to leave it off. A model that would 400 is a model the app must not
  // offer without this being handled.
  check(
    "health offers a reasoning model that needs the temperature omitted",
    health.llm.models.some((model) => model.id === "gpt-5-nano"),
    `models=${health.llm.models.map((model) => model.id).join(",")}`,
  );
  // `provider` names the transport; `baseUrl` carries the endpoint.
  check("health reports the provider transport", health.llm.provider === "openai",
    `provider=${health.llm.provider}`);
  check("health reports the provider base url", health.llm.baseUrl?.includes("4010") === true,
    `baseUrl=${health.llm.baseUrl}`);

  const result = await correct(SAMPLE);

  check("request succeeds", result.status === 200, `status ${result.status}`);
  check("engine reports llm", result.body.engine === "llm", `engine=${result.body.engine}`);
  check("model is echoed back", result.body.model === "gpt-4o-mini", `model=${String(result.body.model)}`);
  check("no fallback reason on the happy path", result.body.fallbackReason === undefined);
  // Every rewrite the analyst proposed is applied to the passage. The sample
  // holds the two errors the mock knows how to find, so both are composed into
  // one sentence: that is what proves the findings reached the rewriter rather
  // than the mock rewriting on its own.
  const COMPOSED = "It was a quiet morning. She had received the letter.";
  check(
    "corrected text comes from the provider",
    String(result.body.corrected) === COMPOSED,
    String(result.body.corrected),
  );

  // Both passes run for every chunk, including a single-paragraph paste, so the
  // findings the reader reads beside the rewrite are always the analyst's.
  check("both passes ran", result.body.requests === 2, `requests=${String(result.body.requests)}`);

  // The side-by-side view is built from the changes, one per original paragraph.
  const changes = changesOf(result.body);
  check("one change per pasted paragraph", changes.length === 1, `changes=${changes.length}`);
  check("the change carries the pasted text on the left", changes[0]?.before === SAMPLE, changes[0]?.before);
  check("the change carries the rewrite on the right", String(changes[0]?.after) === COMPOSED, String(changes[0]?.after));
  check("a rewritten paragraph is not reported as unchanged", changes[0]?.unchanged === false);
  check(
    "the change index is its position in the chapter",
    changes.every((change, position) => change.index === position),
    JSON.stringify(changes.map((change) => change.index)),
  );
  check(
    "the analyst's findings reach the reader on a one-paragraph paste",
    changesOf(result.body)[0]?.notes.length > 0,
    JSON.stringify(notesOf(result.body)),
  );

  console.log("\ntwo-pass contract");

  // Two paragraphs is where the analysis earns its own request, so this is the
  // case that proves the chapter really is sent twice and the findings reach
  // the rewrite.
  await expectParagraphs(2);
  await resetLog();
  const twoParagraphs = await correct(`${SAMPLE}\n\nThe the road was quiet.`);
  const asked = await lastRequests();

  check("a multi-paragraph paste succeeds", twoParagraphs.status === 200, `status ${twoParagraphs.status}`);
  check("both passes ran", twoParagraphs.body.requests === 2, `requests=${String(twoParagraphs.body.requests)}`);

  // The run above is the only thing the mock has been asked for, so the log
  // holds this run's two requests and nothing earlier.
  check("the chapter was sent exactly twice", asked.length === 2, `requests=${asked.length}`);
  check("the first pass is the analyst", asked[0]?.pass === "analyst", String(asked[0]?.pass));
  check("the second pass is the rewriter", asked[1]?.pass === "rewriter", String(asked[1]?.pass));
  check(
    "both passes asked for the same model",
    asked[0]?.model === "gpt-4o-mini" && asked[1]?.model === "gpt-4o-mini",
    JSON.stringify(asked.map((request) => request.model)),
  );
  check(
    "a model that takes a temperature is sent one on both passes",
    asked.every((request) => typeof request.temperature === "number"),
    JSON.stringify(asked.map((request) => request.temperature)),
  );

  const twoChanges = changesOf(twoParagraphs.body);
  check("one change per pasted paragraph", twoChanges.length === 2, `changes=${twoChanges.length}`);

  const findings = notesOf(twoParagraphs.body);
  check("the analyst's findings reach the reader", findings.length > 0, `notes=${findings.length}`);
  check(
    "the entry with no excerpt is dropped",
    !findings.some((note) => note.title.includes("dropped")),
    JSON.stringify(findings.map((note) => note.title)),
  );
  check(
    "an unknown category is coerced to grammar",
    findings.some((note) => note.category === "grammar" && note.excerpt === "The the"),
    JSON.stringify(findings.map((note) => [note.category, note.excerpt])),
  );
  check(
    "each finding names the paragraph it belongs to",
    twoChanges.every((change) => change.notes.every((note) => note.paragraph === change.index)),
    JSON.stringify(twoChanges.map((change) => change.notes.map((note) => note.paragraph))),
  );
  check(
    "the findings are spread across the paragraphs they name",
    new Set(findings.map((note) => note.paragraph)).size === 2,
    JSON.stringify(findings.map((note) => note.paragraph)),
  );
  check(
    "the rewriter applied the rewrite the analyst proposed",
    String(twoParagraphs.body.corrected).includes("The road was quiet"),
    String(twoParagraphs.body.corrected),
  );
  check(
    "a finding carries the reading the author meant",
    findings.every((note) => note.excerpt.length > 0 && note.title.length > 0),
  );
  await expectParagraphs(1);

  console.log("\nmodel selection");

  // The reader picks a model in the UI; the request carries that choice and the
  // provider is asked for it by name.
  const switched = await correct(SAMPLE, "polished", "detect", undefined, "gpt-4.1-mini");
  check("a second model can be chosen", switched.status === 200, `status ${switched.status}`);
  check("the chosen model is the one that ran", switched.body.model === "gpt-4.1-mini", `model=${String(switched.body.model)}`);
  check("the chosen model still uses the provider", switched.body.engine === "llm", `engine=${switched.body.engine}`);
  check(
    "the chosen model returns the same quality of rewrite",
    switched.body.corrected === result.body.corrected,
  );

  // A Gemini id must never reach an OpenAI key, where it would 404 and be
  // reported as a fallback rather than as the wrong click it is.
  const crossProvider = await correct(SAMPLE, "polished", "detect", undefined, "gemini-2.5-pro");
  check("a foreign model does not 400", crossProvider.status === 200, `status ${crossProvider.status}`);
  check(
    "a foreign model keeps the configured one",
    crossProvider.body.model === "gpt-4o-mini",
    `model=${String(crossProvider.body.model)}`,
  );
  check("a foreign model still uses the provider", crossProvider.body.engine === "llm");

  // The cheapest model in the picker is the one a reader is told to try first.
  // It is a reasoning model, which rejects a non-default temperature, so this
  // also proves the transport omits it rather than 400ing on the way in.
  const cheapest = await correct(SAMPLE, "polished", "detect", undefined, "gpt-5-nano");
  check("the cheapest model can be chosen", cheapest.status === 200, `status ${cheapest.status}`);
  check(
    "the cheapest model is the one that ran",
    cheapest.body.model === "gpt-5-nano",
    `model=${String(cheapest.body.model)}`,
  );
  check(
    "the cheapest model still uses the provider",
    cheapest.body.engine === "llm",
    `engine=${cheapest.body.engine}`,
  );
  check(
    "the cheapest model has no fallback reason",
    cheapest.body.fallbackReason === undefined,
    String(cheapest.body.fallbackReason),
  );
  check(
    "the cheapest model returns a real rewrite",
    String(cheapest.body.corrected).length > 0,
  );

  // Speaker attribution is settled from the text alone, so it runs on the
  // provider path too: the model rewrites prose but does not reliably track who
  // is talking across a chapter.
  console.log("\npov on the llm path");

  const korean = `"I'm fine," Minjun said.\n"No, you're not," Minjun said.\n"Fine. Whatever." Minjun said.`;

  const povDetect = await correct(korean, "polished", "detect");
  const detectSpeakers = povDetect.body.speakers as Array<{
    speaker: string | null;
    basis: string;
  }>;
  check(
    "the llm path still resolves every speaker",
    detectSpeakers?.length === 3 && detectSpeakers.every((note) => note.speaker === "Minjun"),
    JSON.stringify(detectSpeakers),
  );
  check(
    "the llm path reports the pov category",
    notesOf(povDetect.body).some((note) => note.category === "pov"),
    JSON.stringify(notesOf(povDetect.body).map((note) => note.category)),
  );
  check(
    "detect mode proposes no rewrite",
    detectSpeakers?.every((note) => !("fix" in note) || note.fix === undefined),
  );

  const povEnforce = await correct(korean, "polished", "enforce");
  check(
    "enforce drops the repeated tag on the llm path",
    typeof povEnforce.body.corrected === "string" &&
      (povEnforce.body.corrected as string).startsWith(`"I'm fine," Minjun said.`),
    String(povEnforce.body.corrected),
  );

  const povOff = await correct(korean, "polished", "off");
  check(
    "pov off returns no speakers",
    povOff.body.speakers !== undefined && (povOff.body.speakers as unknown[]).length === 0,
  );

  // The story bible has to reach the analyst and come back as resolutions. The
  // mock fails the request outright when the dictionary is missing, so a 200
  // here proves the block was actually sent.
  console.log("\ncontinuity dictionary on the llm path");

  const bible = {
    entries: [
      {
        id: "b1",
        kind: "character",
        name: "Phine",
        aliases: ["Phine Grancia", "Mardol"],
        gender: "female",
        role: "Glass Knight",
      },
      { id: "b2", kind: "location", name: "Temple of Tarden" },
    ],
  };

  await expectDictionary(true);
  const withBible = await correct(
    'Mardol lifted her glass mask. "You are late."',
    "polished",
    "detect",
    bible,
  );

  check(
    "the dictionary reaches the provider",
    withBible.status === 200,
    `status ${withBible.status} ${JSON.stringify(withBible.body).slice(0, 160)}`,
  );
  check(
    "an alias is rewritten before the model reads it",
    String(withBible.body.corrected).startsWith("Phine lifted her glass mask."),
    String(withBible.body.corrected).slice(0, 90),
  );

  const continuity = withBible.body.continuity as Array<{
    raw: string;
    canonical: string;
    via?: string;
  }>;
  check(
    "the analyst's own resolutions come back",
    continuity.some((note) => note.raw === "Mardol" && note.canonical === "Phine"),
    JSON.stringify(continuity),
  );
  check(
    "the local rename and the analyst's resolution are both reported",
    continuity.filter((note) => note.canonical === "Phine").length >= 2,
    JSON.stringify(continuity),
  );

  // A dictionary full of junk must not reach the model or break the run, so the
  // request that follows carries no dictionary at all.
  await expectDictionary(false);
  const junk = await correct("Mardol waited.", "polished", "detect", { entries: "nonsense" });
  check("a malformed dictionary is ignored", junk.status === 200 && junk.body.engine === "llm", `engine=${junk.body.engine}`);

  const afterJunk = await correct("It was a quiet morning.", "polished", "detect", undefined);
  check("the run after a bad dictionary still uses the provider", afterJunk.status === 200 && afterJunk.body.engine === "llm", `engine=${afterJunk.body.engine}`);

  await expectDictionary(false);

  console.log("\nfallback path");
  // Each failure mode must degrade to the rules engine with a 200, not a 500.
  await setMode("garbage");  const garbage = await correct(SAMPLE);
  check("unparseable provider output still returns 200", garbage.status === 200, `status ${garbage.status}`);
  check("unparseable provider output falls back to rules", garbage.body.engine === "rules");
  check(
    "fallback explains itself",
    typeof garbage.body.fallbackReason === "string" &&
      (garbage.body.fallbackReason as string).length > 0,
  );
  check(
    "fallback still returns corrected text",
    typeof garbage.body.corrected === "string" && (garbage.body.corrected as string).length > 0,
  );
  check(
    "fallback still returns a side-by-side view",
    changesOf(garbage.body).length > 0,
    `changes=${changesOf(garbage.body).length}`,
  );
  check(
    "fallback reports that it made no provider request",
    garbage.body.requests === 0,
    `requests=${String(garbage.body.requests)}`,
  );

  await setMode("empty");
  const empty = await correct(SAMPLE);
  check(
    "empty provider content falls back to rules",
    empty.status === 200 && empty.body.engine === "rules",
  );

  await setMode("unauthorized");
  const unauthorized = await correct(SAMPLE);
  check(
    "a 401 from the provider falls back to rules",
    unauthorized.status === 200 && unauthorized.body.engine === "rules",
  );
  check(
    "the 401 status is surfaced in the reason",
    String(unauthorized.body.fallbackReason).includes("401"),
    String(unauthorized.body.fallbackReason),
  );

  await setMode("ok");
  const recovered = await correct(SAMPLE);
  check("the app returns to the llm path once the provider recovers", recovered.body.engine === "llm");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

verifyLlmPath().catch((error) => {
  console.error(error);
  process.exit(1);
});
