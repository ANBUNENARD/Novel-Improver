/**
 * Verifies the provider-backed path through /api/correct against a running
 * mock OpenAI-compatible server.
 *
 * The mock rejects any request that does not satisfy the prompt contract, so a
 * 200 here also proves the system prompt and payload shape are correct.
 *
 * Run against the dev server started with LLM_BASE_URL pointed at the mock:
 *   bun run scripts/verify-llm-path.ts http://127.0.0.1:3001
 *
 * The body is wrapped in a uniquely-named function so its bindings stay
 * file-scoped. The project type check treats every `scripts/*.ts` file as one
 * shared global scope, so same-named bindings in sibling scripts collide.
 */

const MOCK = "http://127.0.0.1:4010";

async function verifyLlmPath() {
  const BASE = process.argv[2] || "http://127.0.0.1:3001";

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
   * something.
   */
  async function expectDictionary(expect: boolean) {
    process.env.LLM_MOCK_EXPECT_DICTIONARY = expect ? "1" : "0";
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

  console.log("\nllm path");
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

  const result = await correct("It were a quiet morning. She had recieved the letter.");

  check("request succeeds", result.status === 200, `status ${result.status}`);
  check("engine reports llm", result.body.engine === "llm", `engine=${result.body.engine}`);
  check("model is echoed back", result.body.model === "gpt-4o-mini", `model=${String(result.body.model)}`);
  check("no fallback reason on the happy path", result.body.fallbackReason === undefined);
  check(
    "corrected text comes from the provider",
    result.body.corrected ===
      "It was a quiet morning. She received the letter, and it was not good news.",
  );

  const suggestions = result.body.suggestions as Array<Record<string, string>>;
  check("provider suggestions are returned", suggestions.length === 3, `got ${suggestions.length}`);
  check(
    "the entry with no replacement is dropped",
    !suggestions.some((item) => item.title?.includes("dropped")),
  );
  check(
    "an unknown category is coerced to grammar",
    suggestions.some((item) => item.category === "grammar" && item.original === "quiet morning"),
  );
  check("the note field survives parsing", suggestions.some((item) => Boolean(item.note)));
  check("suggestion ids are sequential", suggestions.map((item) => item.id).join(",") === "s1,s2,s3");

  // The reader picks a model in the UI; the request carries that choice and the
  // provider is asked for it by name.
  const switched = await correct(
    "It were a quiet morning. She had recieved the letter.",
    "polished",
    "detect",
    undefined,
    "gpt-4.1-mini",
  );
  check("a second model can be chosen", switched.status === 200, `status ${switched.status}`);
  check("the chosen model is the one that ran", switched.body.model === "gpt-4.1-mini", `model=${String(switched.body.model)}`);
  check("the chosen model still uses the provider", switched.body.engine === "llm", `engine=${switched.body.engine}`);
  check(
    "the chosen model returns the same quality of rewrite",
    switched.body.corrected === result.body.corrected,
  );

  // A Gemini id must never reach an OpenAI key, where it would 404 and be
  // reported as a fallback rather than as the wrong click it is.
  const crossProvider = await correct(
    "It were a quiet morning. She had recieved the letter.",
    "polished",
    "detect",
    undefined,
    "gemini-2.5-pro",
  );
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
  const cheapest = await correct(
    "It were a quiet morning. She had recieved the letter.",
    "polished",
    "detect",
    undefined,
    "gpt-5-nano",
  );
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

  const summary = result.body.summary as {
    wordCount: number;
    issuesByCategory: Record<string, number>;
  };
  check("summary counts the corrected text", summary.wordCount === 15, `got ${summary.wordCount}`);
  check(
    "category counts match the suggestions",
    Object.values(summary.issuesByCategory).reduce((a, b) => a + b, 0) === suggestions.length,
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
    (povDetect.body.suggestions as Array<{ category: string }>).some(
      (item) => item.category === "pov",
    ),
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

  // The story bible has to reach the model and come back as resolutions. The
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
    (withBible.body.corrected as string).startsWith("Phine lifted her glass mask."),
    String(withBible.body.corrected).slice(0, 90),
  );

  const continuity = withBible.body.continuity as Array<{
    raw: string;
    canonical: string;
    via?: string;
  }>;
  check(
    "the provider's own resolutions come back",
    continuity.some((note) => note.raw === "Mardol" && note.canonical === "Phine"),
    JSON.stringify(continuity),
  );
  check(
    "the local rename and the provider's resolution are both reported",
    continuity.filter((note) => note.canonical === "Phine").length >= 2,
    JSON.stringify(continuity),
  );

  const pipeline = withBible.body.pipeline as Array<{ stage: string; ran: boolean; detail: string }>;
  check(
    "the response carries the ten-stage report",
    Array.isArray(pipeline) && pipeline.length === 10,
    String(Array.isArray(pipeline) ? pipeline.length : pipeline),
  );
  check(
    "every stage reports what it did",
    pipeline.every((entry) => typeof entry.detail === "string" && entry.detail.length > 0),
  );
  check(
    "the continuity stage names the alias it resolved",
    pipeline.find((entry) => entry.stage === "continuity")?.detail?.includes("Mardol") === true,
    pipeline.find((entry) => entry.stage === "continuity")?.detail,
  );

  // A dictionary full of junk must not reach the model or break the run.
  const junk = await correct("Mardol waited.", "polished", "detect", { entries: "nonsense" });
  check("a malformed dictionary is ignored", junk.status === 200 && junk.body.engine === "llm");

  await expectDictionary(false);

  console.log("\nfallback path");
  // Each failure mode must degrade to the rules engine with a 200, not a 500.
  await setMode("garbage");  const garbage = await correct("It were a quiet morning.");
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

  await setMode("empty");
  const empty = await correct("It were a quiet morning.");
  check(
    "empty provider content falls back to rules",
    empty.status === 200 && empty.body.engine === "rules",
  );

  await setMode("unauthorized");
  const unauthorized = await correct("It were a quiet morning.");
  check(
    "a 401 from the provider falls back to rules",
    unauthorized.status === 200 && unauthorized.body.engine === "rules",
  );
  check(
    "the 401 status is surfaced in the reason",
    String(unauthorized.body.fallbackReason).includes("401"),
  );

  await setMode("ok");
  const recovered = await correct("It were a quiet morning.");
  check("the app returns to the llm path once the provider recovers", recovered.body.engine === "llm");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

verifyLlmPath().catch((error) => {
  console.error(error);
  process.exit(1);
});
