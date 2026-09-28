/**
 * Verifies the Gemini transport through /api/correct against a mock
 * `generateContent` server.
 *
 * Gemini does not speak the OpenAI protocol, so this runs the same behavioural
 * checks as verify-llm-path.ts against a server that answers the Google shape.
 * A 200 proves the request body, the header auth, and the reply parsing all
 * line up, and the failure modes prove the app still falls back to the rules
 * engine rather than showing the reader an error.
 *
 * Run against a server started with:
 *   LLM_PROVIDER=gemini LLM_API_KEY=test-key
 *   LLM_BASE_URL=http://127.0.0.1:4020 LLM_MODEL=gemini-2.5-flash
 *   bun run scripts/verify-gemini-path.ts http://127.0.0.1:3002
 *
 * The body is wrapped in a uniquely-named function so its bindings stay
 * file-scoped. The project type check treats every `scripts/*.ts` file as one
 * shared global scope, so same-named bindings in sibling scripts collide.
 */

const MOCK = "http://127.0.0.1:4020";

async function verifyGeminiPath() {
  const BASE = process.argv[2] || "http://127.0.0.1:3002";

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

  async function setMode(mode: string) {
    const response = await fetch(`${MOCK}/__mock/mode?mode=${mode}`);
    const body = (await response.json()) as { mode: string };
    if (body.mode !== mode) throw new Error(`mock did not switch to "${mode}"`);
  }

  /**
   * The mock rejects an analyst request whose dictionary presence disagrees
   * with this flag, so a 200 proves the engine actually sent the block. It goes
   * over HTTP because the flag is read inside the mock, a different process.
   */
  async function expectDictionary(expect: boolean) {
    await fetch(`${MOCK}/__mock/expect-dictionary?value=${expect ? "1" : "0"}`);
  }

  /** Clears the request log so a check can read exactly one run's requests. */
  async function resetLog() {
    await fetch(`${MOCK}/__mock/reset`);
  }

  /** What the mock was actually asked, per pass. */
  async function lastRequests() {
    const body = (await (await fetch(`${MOCK}/__mock/last`)).json()) as {
      requests: Array<{ pass: string; model: string | null; hasDictionary: boolean }>;
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

  console.log("\ngemini path");
  await setMode("ok");
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
  check("health names gemini as the provider", health.llm.provider === "gemini",
    `provider=${health.llm.provider}`);
  check("health reports the configured model", health.llm.model === "gemini-2.5-flash",
    `model=${health.llm.model}`);
  check("health offers the gemini models to the picker", health.llm.models.length === 2,
    `models=${health.llm.models.map((model) => model.id).join(",")}`);
  check("health offers no openai models on a gemini key",
    health.llm.models.every((model) => model.id.startsWith("gemini-")));
  check("health reports the provider base url", health.llm.baseUrl?.includes("4020") === true,
    `baseUrl=${health.llm.baseUrl}`);

  const result = await correct(SAMPLE);

  check("request succeeds", result.status === 200, `status ${result.status}`);
  check("engine reports llm", result.body.engine === "llm", `engine=${result.body.engine}`);
  check("model is echoed back", result.body.model === "gemini-2.5-flash",
    `model=${String(result.body.model)}`);
  check("no fallback reason on the happy path", result.body.fallbackReason === undefined,
    String(result.body.fallbackReason));

  // The mock reads the passage out of the prompt and applies the analyst's
  // rewrites to it, so the two errors below surviving and the one below them
  // fixed together prove the user prompt was read out of the Gemini request
  // body and the reply was read back out of the response.
  check(
    "the prompt reaches the model and the reply is read back",
    String(result.body.corrected) === "It was a quiet morning. She had received the letter.",
    String(result.body.corrected).slice(0, 160),
  );

  console.log("\ntwo-pass contract");

  // Two paragraphs is where the analysis earns its own request, so this is the
  // case that proves the chapter really is sent twice through Gemini.
  await resetLog();
  const twoParagraphs = await correct(`${SAMPLE}\n\nThe the road was quiet.`);
  const asked = await lastRequests();

  check("a multi-paragraph paste succeeds", twoParagraphs.status === 200, `status ${twoParagraphs.status}`);
  check("both passes ran", twoParagraphs.body.requests === 2, `requests=${String(twoParagraphs.body.requests)}`);
  check("the chapter was sent exactly twice", asked.length === 2, `requests=${asked.length}`);
  check("the first pass is the analyst", asked[0]?.pass === "analyst", String(asked[0]?.pass));
  check("the second pass is the rewriter", asked[1]?.pass === "rewriter", String(asked[1]?.pass));
  check(
    "both passes asked for the same model",
    asked[0]?.model === "gemini-2.5-flash" && asked[1]?.model === "gemini-2.5-flash",
    JSON.stringify(asked.map((request) => request.model)),
  );
  check(
    "neither pass carries the dictionary when there is none",
    asked.every((request) => !request.hasDictionary),
    JSON.stringify(asked.map((request) => request.hasDictionary)),
  );

  const twoChanges = changesOf(twoParagraphs.body);
  check("one change per pasted paragraph", twoChanges.length === 2, `changes=${twoChanges.length}`);
  check("the change carries the pasted text on the left", twoChanges[0]?.before === SAMPLE, twoChanges[0]?.before);
  check(
    "the change index is its position in the chapter",
    twoChanges.every((change, position) => change.index === position),
    JSON.stringify(twoChanges.map((change) => change.index)),
  );
  check(
    "a rewritten paragraph is not reported as unchanged",
    twoChanges[0]?.unchanged === false,
    `unchanged=${twoChanges[0]?.unchanged}`,
  );

  const findings = notesOf(twoParagraphs.body);
  check("the analyst's findings reach the reader", findings.length >= 3, `notes=${findings.length}`);
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

  console.log("\nmodel selection");

  // The other Gemini model in the picker, and a GPT id that a Gemini key cannot
  // reach. The first must be used; the second must keep the configured one.
  const pro = await correct(SAMPLE, "polished", "detect", undefined, "gemini-2.5-pro");
  check("the pro model can be chosen", pro.status === 200, `status ${pro.status}`);
  check("the pro model is the one that ran", pro.body.model === "gemini-2.5-pro",
    `model=${String(pro.body.model)}`);
  check("the pro model still uses the provider", pro.body.engine === "llm",
    `engine=${pro.body.engine}`);

  const crossProvider = await correct(SAMPLE, "polished", "detect", undefined, "gpt-4o");
  check("an openai model on a gemini key does not 400", crossProvider.status === 200,
    `status ${crossProvider.status}`);
  check("an openai model on a gemini key keeps the configured one",
    crossProvider.body.model === "gemini-2.5-flash", `model=${String(crossProvider.body.model)}`);
  check("an openai model on a gemini key still uses the provider",
    crossProvider.body.engine === "llm", `engine=${crossProvider.body.engine}`);

  console.log("\npov on the gemini path");

  const korean = `"I'm fine," Minjun said.\n"No, you're not," Minjun said.\n"Fine. Whatever." Minjun said.`;

  const povDetect = await correct(korean, "polished", "detect");
  const detectSpeakers = povDetect.body.speakers as Array<{ speaker: string | null; basis: string }>;
  check(
    "the gemini path still resolves every speaker",
    detectSpeakers?.length === 3 && detectSpeakers.every((note) => note.speaker === "Minjun"),
    JSON.stringify(detectSpeakers),
  );
  check(
    "the gemini path reports the pov category",
    notesOf(povDetect.body).some((note) => note.category === "pov"),
    JSON.stringify(notesOf(povDetect.body).map((note) => note.category)),
  );

  const povEnforce = await correct(korean, "polished", "enforce");
  check(
    "enforce drops the repeated tag on the gemini path",
    typeof povEnforce.body.corrected === "string" &&
      (povEnforce.body.corrected as string).startsWith(`"I'm fine," Minjun said.`),
    String(povEnforce.body.corrected),
  );

  const povOff = await correct(korean, "polished", "off");
  check(
    "pov off returns no speakers",
    povOff.body.speakers !== undefined && (povOff.body.speakers as unknown[]).length === 0,
  );

  console.log("\ncontinuity dictionary on the gemini path");

  // The mock fails the request outright when the analyst's dictionary is
  // missing or malformed, so a 200 here proves the block was actually sent.
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
  const withBible = await correct('Mardol lifted her glass mask. "You are late."', "polished", "detect", bible);

  check(
    "the dictionary reaches the analyst",
    withBible.status === 200,
    `status ${withBible.status} ${JSON.stringify(withBible.body).slice(0, 160)}`,
  );
  check(
    "an alias is rewritten before the model reads it",
    String(withBible.body.corrected).startsWith("Phine lifted her glass mask."),
    String(withBible.body.corrected).slice(0, 90),
  );

  const continuity = withBible.body.continuity as Array<{ raw: string; canonical: string; via?: string }>;
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
  check(
    "no name is reported twice",
    new Set(continuity.map((note) => `${note.canonical}:${note.raw.toLowerCase()}`)).size ===
      continuity.length,
    JSON.stringify(continuity),
  );

  // A dictionary full of junk must not reach the model or break the run, so the
  // request that follows carries no dictionary at all.
  await expectDictionary(false);
  const junk = await correct("Mardol waited.", "polished", "detect", { entries: "nonsense" });
  check("a malformed dictionary is ignored", junk.status === 200 && junk.body.engine === "llm", `engine=${junk.body.engine}`);

  const afterJunk = await correct("It was a quiet morning.", "polished", "detect", undefined);
  check("the run after a bad dictionary still uses the provider", afterJunk.status === 200 && afterJunk.body.engine === "llm", `engine=${afterJunk.body.engine}`);

  console.log("\nfallback path");
  // Each failure mode must degrade to the rules engine with a 200, not a 500.
  // The mode is set on the mock because the app never forwards a client header
  // to the provider.
  const reasons: string[] = [];

  for (const [mode, label] of [
    ["http500", "a provider error"],
    ["http401", "a rejected key"],
    ["nonsense", "a reply that is not json"],
  ] as const) {
    await setMode(mode);
    const fell = await correct(SAMPLE);
    reasons.push(String(fell.body.fallbackReason));

    check(
      `${label} falls back to the rules engine`,
      fell.status === 200 && fell.body.engine === "rules",
      `status ${fell.status}, engine=${fell.body.engine}`,
    );
    check(
      `${label} still returns a corrected chapter`,
      typeof fell.body.corrected === "string" && (fell.body.corrected as string).length > 0,
    );
    check(
      `${label} still returns a side-by-side view`,
      changesOf(fell.body).length > 0,
      `changes=${changesOf(fell.body).length}`,
    );
    check(
      `${label} reports that it made no provider request`,
      fell.body.requests === 0,
      `requests=${String(fell.body.requests)}`,
    );
    check(
      `${label} explains itself in fallbackReason`,
      typeof fell.body.fallbackReason === "string" && (fell.body.fallbackReason as string).length > 0,
    );
  }

  // A 401 is the case a reader is most likely to hit, so the reason must name
  // the status rather than failing as a vague transport error.
  check(
    "a rejected key is reported as such",
    reasons[1].includes("401"),
    reasons[1],
  );
  check(
    "a prose reply is reported as a parse failure",
    /json|parse/i.test(reasons[2]),
    reasons[2],
  );

  await setMode("ok");
  const recovered = await correct(SAMPLE);
  check("the app returns to the llm path once the provider recovers", recovered.body.engine === "llm");
  check("the recovered run uses the provider again", recovered.body.requests === 2, `requests=${String(recovered.body.requests)}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

await verifyGeminiPath();

export {};
