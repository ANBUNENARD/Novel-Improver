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

  async function correct(text: string, tone = "polished", povMode = "detect", model?: string) {
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
        ...(model ? { model } : {}),
      }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  console.log("\ngemini path");
  await setMode("ok");

  const health = (await (await fetch(`${BASE}/api/health`)).json()) as {
    llm: {
      configured: boolean;
      model: string | null;
      defaultModel: string | null;
      provider: string | null;
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

  const passage = "It were a quiet morning. She had recieved the letter.";
  const result = await correct(passage);

  check("request succeeds", result.status === 200, `status ${result.status}`);
  check("engine reports llm", result.body.engine === "llm", `engine=${result.body.engine}`);
  check("model is echoed back", result.body.model === "gemini-2.5-flash",
    `model=${String(result.body.model)}`);
  check("no fallback reason on the happy path", result.body.fallbackReason === undefined,
    String(result.body.fallbackReason));

  // The mock extracts the passage out of the prompt and echoes it back as the
  // corrected text, so an exact round trip proves the user prompt was read out
  // of the Gemini request body and the reply was read back out of the response.
  check(
    "the prompt reaches the model and the reply is read back",
    result.body.corrected === passage,
    String(result.body.corrected).slice(0, 160),
  );

  // The other Gemini model in the picker, and a GPT id that a Gemini key cannot
  // reach. The first must be used; the second must fall back silently.
  const pro = await correct(passage, "polished", "detect", "gemini-2.5-pro");
  check("the pro model can be chosen", pro.status === 200, `status ${pro.status}`);
  check("the pro model is the one that ran", pro.body.model === "gemini-2.5-pro",
    `model=${String(pro.body.model)}`);
  check("the pro model still uses the provider", pro.body.engine === "llm",
    `engine=${pro.body.engine}`);

  const crossProvider = await correct(passage, "polished", "detect", "gpt-4o");
  check("an openai model on a gemini key does not 400", crossProvider.status === 200,
    `status ${crossProvider.status}`);
  check("an openai model on a gemini key keeps the configured one",
    crossProvider.body.model === "gemini-2.5-flash", `model=${String(crossProvider.body.model)}`);
  check("an openai model on a gemini key still uses the provider",
    crossProvider.body.engine === "llm", `engine=${crossProvider.body.engine}`);

  const suggestions = result.body.suggestions as Array<Record<string, string>>;
  check("provider suggestions are returned", suggestions.length >= 1, `got ${suggestions.length}`);
  check(
    "a gemini suggestion keeps its category and note",
    suggestions.some((item) => item.category === "pov" && Boolean(item.note)),
    JSON.stringify(suggestions),
  );

  const continuity = result.body.continuity as Array<Record<string, string>>;
  check("gemini continuity notes are parsed", continuity.length === 1, `got ${continuity.length}`);
  check("the note keeps both names", continuity[0]?.raw === "Mardol" && continuity[0]?.canonical === "Phine",
    JSON.stringify(continuity[0]));

  const pipeline = result.body.pipeline as Array<{ stage: string; ran: boolean }>;
  check("the pipeline still reports every stage on the gemini path", pipeline.length === 10,
    `got ${pipeline.length}`);

  // ------------------------------------------------------------- fallback
  // A provider that is down, rejects the key, or answers with prose instead of
  // JSON must leave the reader with a corrected chapter, never an error page.
  // The mode is set on the mock because the app never forwards a client header
  // to the provider.
  console.log("\ngemini fallback");

  const reasons: string[] = [];

  for (const [mode, label] of [
    ["http500", "a provider error"],
    ["http401", "a rejected key"],
    ["nonsense", "a reply that is not json"],
  ] as const) {
    await setMode(mode);
    const fell = await correct(passage);
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

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

await verifyGeminiPath();

export {};
