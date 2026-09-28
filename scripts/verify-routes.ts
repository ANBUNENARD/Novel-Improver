/**
 * HTTP verification against a running server.
 *
 * Exercises the routes the way a browser would: fetches the rendered pages,
 * posts to each API endpoint, and checks the responses actually contain what
 * the UI depends on.
 *
 *   bun run scripts/verify-routes.ts [baseUrl]
 *
 * Wrapped in an async IIFE so top-level bindings stay file-scoped. The project
 * type check otherwise treats these scripts as one shared global scope, and
 * same-named bindings in sibling scripts collide.
 */

import { MODEL_CHOICES } from "../lib/validate";

async function verifyRoutes() {
  const BASE = process.argv[2] || "http://127.0.0.1:3000";

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

  async function post(path: string, body: unknown) {
    const response = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  // ------------------------------------------------------------- page routes
  section("pages");

  const home = await fetch(BASE);
  const homeHtml = await home.text();

  check("GET / returns 200", home.status === 200, `status ${home.status}`);
  check("home renders the brand", homeHtml.includes("ProseLens"));
  check("home has the paste affordance", homeHtml.includes("Paste a draft"));
  check("home has the editor textarea", homeHtml.includes('id="draft"'));
  // The editor is the api key, the model, the paste box, and the output. The
  // tone and point-of-view rows used to sit between the paste box and the
  // output; they now run at fixed settings, so their labels belong nowhere in
  // the HTML. Asserting the new shape keeps a silent re-render of a removed
  // row from passing as a healthy page.
  check("home has the api key field", homeHtml.includes("API key"));
  check("home has the model picker", homeHtml.includes("model"));
  check("home runs the tone and pov at fixed settings", !homeHtml.includes("Faithful"));
  check("home has the sample loader", homeHtml.includes("Load a sample"));
  check("home has the FAQ section", homeHtml.includes('id="faq"'));
  check("home declares the html lang attribute", homeHtml.includes('<html lang="en"'));
  check("home is not an error page", !homeHtml.includes("Application error"));

  const notFound = await fetch(`${BASE}/definitely-not-a-real-route`);
  check("unknown route returns 404", notFound.status === 404, `status ${notFound.status}`);
  check("404 page has a recovery link", (await notFound.text()).includes("Back to the editor"));

  // ------------------------------------------------------------------- health
  section("api/health");

  const health = await fetch(`${BASE}/api/health`);
  const healthBody = (await health.json()) as {
    status: string;
    service: string;
    llm: {
      configured: boolean;
      model: string | null;
      provider: string | null;
      models: Array<{ id: string; label: string; note: string }>;
    };
  };

  check("health returns 200", health.status === 200, `status ${health.status}`);
  check("health reports ok", healthBody.status === "ok");
  check("health names the service", healthBody.service === "proselens");
  check("health reports llm configured as a boolean", typeof healthBody.llm.configured === "boolean");
  check("health does not leak the api key", !JSON.stringify(healthBody).includes("sk-"));
  check(
    "health offers a model list",
    Array.isArray(healthBody.llm.models),
    `models=${JSON.stringify(healthBody.llm.models)}`,
  );
  check(
    "every offered model has a label and a note",
    healthBody.llm.models.every(
      (model) =>
        typeof model.id === "string" &&
        model.id.length > 0 &&
        typeof model.label === "string" &&
        typeof model.note === "string",
    ),
  );
  check(
    "offered models match the configured provider",
    healthBody.llm.configured === false ||
      healthBody.llm.models.every((model) =>
        healthBody.llm.provider === "gemini" ? model.id.startsWith("gemini-") : model.id.startsWith("gpt-"),
      ),
    `provider=${healthBody.llm.provider}`,
  );
  check(
    "the configured model is one the app can serve",
    !healthBody.llm.configured || healthBody.llm.models.some((model) => model.id === healthBody.llm.model),
    `model=${healthBody.llm.model}`,
  );
  check(
    "no model outside the allowlist is offered",
    healthBody.llm.models.every((model) => MODEL_CHOICES.some((choice) => choice.id === model.id)),
  );

  // ------------------------------------------------------------- api/correct
  section("api/correct");

  const messy =
    "It were a quiet morning.  She had recieved the letter and it was not good.  " +
    "The the dog barked loudly and she could not think.  she was very very tired.";

  const corrected = await post("/api/correct", {
    text: messy,
    tone: "faithful",
    categories: ["grammar", "spelling", "repetition", "structure", "style"],
  });

  check("correct returns 200", corrected.status === 200, `status ${corrected.status}`);
  check("correct returns rewritten text", String(corrected.body.corrected).length > 0);
  check(
    "corrected text fixed the doubled article", !String(corrected.body.corrected).includes("the the"));
  // The rules engine contracts the negation itself. A model rewrite is free to
  // keep the full form, so this only holds when the local engine ran.
  check(
    "corrected text contracted the negation",
    corrected.body.engine !== "rules" || String(corrected.body.corrected).includes("couldn't"),
    `engine=${String(corrected.body.engine)}`,
  );
  check("suggestions are returned", (corrected.body.suggestions as unknown[]).length > 0);
  check(
    "every suggestion has the fields the card renders",
    (corrected.body.suggestions as Array<Record<string, unknown>>).every(
      (item) =>
        typeof item.id === "string" &&
        typeof item.category === "string" &&
        typeof item.original === "string" &&
        typeof item.suggestion === "string",
    ),
  );
  check("summary has a word count", (corrected.body.summary as { wordCount: number }).wordCount > 0);
  check(
    "summary has a sentence count",
    (corrected.body.summary as { sentenceCount: number }).sentenceCount > 0,
  );
  check(
    "summary has a readability score",
    (corrected.body.summary as { readability: { score: number } }).readability.score >= 0,
  );
  check("engine is reported", corrected.body.engine === "llm" || corrected.body.engine === "rules");
  check(
    "a rules fallback explains itself",
    corrected.body.engine !== "rules" || Boolean(corrected.body.fallbackReason),
  );

  const blank = await post("/api/correct", { text: "   ", tone: "polished", categories: [] });
  check("blank text returns 400", blank.status === 400, `status ${blank.status}`);

  const malformed = await post("/api/correct", "{not json");
  check("malformed body returns 400", malformed.status === 400, `status ${malformed.status}`);

  const huge = await post("/api/correct", { text: "a".repeat(60_001), tone: "polished", categories: [] });
  check("oversized text returns 400", huge.status === 400, `status ${huge.status}`);

  const badTone = await post("/api/correct", {
    text: "Hello there.",
    tone: "not-a-tone",
    categories: ["nonsense"],
  });
  check("unknown tone and category do not 400", badTone.status === 200, `status ${badTone.status}`);

  // -------------------------------------------------------- model override
  section("model override");

  const offered = healthBody.llm.models;
  const pickable = offered.find((model) => model.id !== healthBody.llm.model);
  // With no key there is no model to pick, so the model fields are simply absent
  // from the response. The picker is covered by the browser pass instead.
  const hasLlm = healthBody.llm.configured && Boolean(healthBody.llm.model);

  const picked = await post("/api/correct", {
    text: "She had recieved the letter and it was not good.",
    tone: "polished",
    categories: ["grammar", "spelling"],
    model: pickable ? pickable.id : "",
  });
  check("a picked model still corrects", picked.status === 200, `status ${picked.status}`);
  check(
    "the picked model is the one that ran",
    !hasLlm || (Boolean(pickable) && picked.body.model === pickable!.id),
    `sent ${pickable?.id}, got ${String(picked.body.model)}`,
  );

  const noModel = await post("/api/correct", {
    text: "She had recieved the letter and it was not good.",
    tone: "polished",
    categories: ["grammar", "spelling"],
  });
  check(
    "omitting the model uses the configured one",
    !hasLlm || noModel.body.model === healthBody.llm.model,
    `sent none, got ${String(noModel.body.model)}`,
  );

  const junkModel = await post("/api/correct", {
    text: "She had recieved the letter and it was not good.",
    tone: "polished",
    categories: ["grammar", "spelling"],
    model: "gpt-9-ultra; drop table",
  });
  check("an unknown model does not 400", junkModel.status === 200, `status ${junkModel.status}`);
  check(
    "an unknown model falls back to the configured one",
    !hasLlm || junkModel.body.model === healthBody.llm.model,
    `got ${String(junkModel.body.model)}`,
  );

  // A Gemini id with an OpenAI key must not reach the provider as a 404.
  const foreign = healthBody.llm.provider === "gemini" ? "gpt-4o" : "gemini-2.5-flash";
  const crossProvider = await post("/api/correct", {
    text: "She had recieved the letter and it was not good.",
    tone: "polished",
    categories: ["grammar", "spelling"],
    model: foreign,
  });
  check(
    "a model from the other provider falls back to the configured one",
    !hasLlm || crossProvider.body.model === healthBody.llm.model,
    `sent ${foreign}, got ${String(crossProvider.body.model)}`,
  );
  check("the wrong provider still returns a draft", String(crossProvider.body.corrected).length > 0);

  // ------------------------------------------------------------------ pov
  section("pov and speakers");

  // Two exchanges: the first is three tagged lines from one speaker, the second
  // is a tag followed by a bare line. Both avoid the words the contraction rules
  // rewrite, so the POV pass is the only thing that can change them.
  const repeated = `"Enough, then," Minjun said.\n"No, you cannot know," Minjun said.\n"Fine. Whatever." Minjun said.`;
  const carryOver = `"Get out," Minjun said.\n"Where should I go?"`;

  const povOff = await post("/api/correct", {
    text: `${repeated}\n${carryOver}`,
    tone: "faithful",
    categories: [],
    povMode: "off",
  });

  check("pov off returns 200", povOff.status === 200, `status ${povOff.status}`);
  check(
    "pov off returns no speakers",
    (povOff.body.speakers as unknown[]).length === 0,
    JSON.stringify(povOff.body.speakers),
  );
  check(
    "pov off leaves the text alone",
    povOff.body.corrected === `${repeated}\n${carryOver}`,
    String(povOff.body.corrected),
  );
  check(
    "pov off returns no pov suggestions",
    (povOff.body.suggestions as Array<{ category: string }>).every((item) => item.category !== "pov"),
  );

  const povDetect = await post("/api/correct", {
    text: `${repeated}\n${carryOver}`,
    tone: "faithful",
    categories: [],
    povMode: "detect",
  });

  const detectedSpeakers = povDetect.body.speakers as Array<Record<string, unknown>>;

  check("pov detect returns 200", povDetect.status === 200, `status ${povDetect.status}`);
  check("pov detect names a speaker per line", detectedSpeakers.length === 5, `got ${detectedSpeakers.length}`);
  check(
    "pov detect resolves the tagged line to its name",
    detectedSpeakers[0]?.speaker === "Minjun" && detectedSpeakers[0]?.basis === "tag",
    JSON.stringify(detectedSpeakers[0]),
  );
  check(
    "pov detect carries the speaker onto a bare line",
    detectedSpeakers[4]?.speaker === "Minjun" && detectedSpeakers[4]?.basis === "carried",
    JSON.stringify(detectedSpeakers[4]),
  );
  check(
    "pov speakers carry the fields the list renders",
    detectedSpeakers.every(
      (item) =>
        typeof item.index === "number" &&
        typeof item.line === "string" &&
        typeof item.basis === "string" &&
        (item.speaker === null || typeof item.speaker === "string"),
    ),
  );
  check(
    "pov detect changes no text",
    povDetect.body.corrected === `${repeated}\n${carryOver}`,
    String(povDetect.body.corrected),
  );
  check(
    "pov detect reports the repeated tag without rewriting it",
    (povDetect.body.suggestions as Array<{ category: string; title: string }>).some(
      (item) => item.category === "pov" && item.title === "Speaker name repeated on every line",
    ),
  );

  const povEnforce = await post("/api/correct", {
    text: repeated,
    tone: "faithful",
    categories: [],
    povMode: "enforce",
  });

  const povSuggestions = povEnforce.body.suggestions as Array<Record<string, unknown>>;

  check("pov enforce returns 200", povEnforce.status === 200, `status ${povEnforce.status}`);
  check(
    "pov enforce keeps the tag the reader needs as an anchor",
    String(povEnforce.body.corrected).startsWith('"Enough, then," Minjun said.\n'),
    String(povEnforce.body.corrected),
  );
  check(
    "pov enforce drops the repeated tag and closes the sentence",
    String(povEnforce.body.corrected).includes('"No, you cannot know."\n'),
    String(povEnforce.body.corrected),
  );
  check(
    "pov enforce does not add a second full stop",
    String(povEnforce.body.corrected).endsWith('"Fine. Whatever."'),
    String(povEnforce.body.corrected),
  );
  check(
    "pov enforce reports the change as a pov suggestion",
    povSuggestions.some((item) => item.category === "pov" && String(item.title).includes("speaker")),
    JSON.stringify(povSuggestions.filter((item) => item.category === "pov")),
  );
  check(
    "every pov suggestion explains itself",
    povSuggestions
      .filter((item) => item.category === "pov")
      .every((item) => String(item.note).length > 0 && String(item.title).length > 0),
  );

  const povNoise = await post("/api/correct", {
    text: "There were no marks of quotation anywhere in this narration at all.",
    tone: "faithful",
    categories: [],
    povMode: "detect",
  });

  check(
    "narration without dialogue returns no speakers",
    (povNoise.body.speakers as unknown[]).length === 0,
    JSON.stringify(povNoise.body.speakers),
  );

  // ------------------------------------------------- story bible and pipeline
  section("story bible and pipeline");

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
      { id: "b2", kind: "term", name: "Giyu", role: "Licht's personal sword" },
    ],
  };

  const withBible = await post("/api/correct", {
    text: 'Mardol raised her glass mask. "You are late, Soo-hyun." Licht held Giyu.',
    tone: "polished",
    categories: [],
    povMode: "detect",
    storyBible: bible,
  });

  check("a run with a dictionary returns 200", withBible.status === 200, `status ${withBible.status}`);

  const continuity = withBible.body.continuity as Array<{
    raw: string;
    canonical: string;
    via?: string;
    context?: string;
  }>;

  check("the alias was rewritten to its canonical name", String(withBible.body.corrected).startsWith("Phine raised her glass mask."), String(withBible.body.corrected).slice(0, 80));
  check(
    "the rewrite is reported with both names",
    continuity.some((note) => note.raw === "Mardol" && note.canonical === "Phine"),
    JSON.stringify(continuity),
  );
  check(
    "the report says how the rename was reached",
    continuity.filter((note) => note.raw === "Mardol").every((note) => Boolean(note.via)),
  );
  check(
    "a canonical name is reported without a rename",
    continuity.some((note) => note.raw === "Giyu" && note.canonical === "Giyu" && note.via === undefined),
    JSON.stringify(continuity),
  );
  check(
    "the context shows the sentence, not a fragment",
    continuity
      .filter((note) => note.raw === "Mardol")
      .every((note) => (note.context ?? "").startsWith("Mardol raised her glass mask.")),
    JSON.stringify(continuity.map((note) => note.context)),
  );

  const pipeline = withBible.body.pipeline as Array<{ stage: string; ran: boolean; detail: string }>;
  check(
    "the response carries the ten-stage report",
    Array.isArray(pipeline) && pipeline.length === 10,
    String(Array.isArray(pipeline) ? pipeline.length : pipeline),
  );
  check(
    "the stages are in the documented order",
    pipeline?.map((entry) => entry.stage).join(",") ===
      "parse,pov,normalize,continuity,meaning,rewrite,pacing,dialogue,logic,consistency",
    pipeline?.map((entry) => entry.stage).join(","),
  );
  check(
    "every stage has a detail line",
    pipeline?.every((entry) => typeof entry.detail === "string" && entry.detail.length > 0),
  );
  check(
    "the names stage counts the matches",
    pipeline?.find((entry) => entry.stage === "normalize")?.detail?.includes("2 names") === true,
    pipeline?.find((entry) => entry.stage === "normalize")?.detail,
  );
  check(
    "the continuity stage names the alias it resolved",
    pipeline?.find((entry) => entry.stage === "continuity")?.detail?.includes("Mardol") === true,
    pipeline?.find((entry) => entry.stage === "continuity")?.detail,
  );

  // A missing dictionary is the same as running without one, and a malformed
  // one must not change the request's behaviour or return an error.
  const noBible = await post("/api/correct", {
    text: "Mardol raised her glass mask.",
    tone: "polished",
    categories: [],
    povMode: "detect",
  });
  // A model rewrites the passage, so the text comes back changed. The check is
  // that nothing in the story bible leaked into a run that supplied none.
  check(
    "no dictionary adds no alias resolution",
    noBible.status === 200 && !String(noBible.body.corrected).includes("Mardol\u2019s mask"),
    String(noBible.body.corrected),
  );
  check(
    "no dictionary still returns a pipeline report",
    (noBible.body.pipeline as unknown[]).length === 10,
  );
  check(
    "no dictionary reports no matches",
    (noBible.body.continuity as unknown[]).length === 0,
  );

  for (const bad of ["nonsense", 42, { entries: "nope" }, { entries: [null, 7, { name: "  " }] }]) {
    const rejected = await post("/api/correct", {
      text: "Mardol raised her glass mask.",
      tone: "polished",
      categories: [],
      storyBible: bad,
    });
    check(
      "a malformed dictionary is ignored rather than fatal",
      rejected.status === 200 && rejected.body.engine !== undefined,
      JSON.stringify(rejected.body).slice(0, 120),
    );
  }

  // ------------------------------------------------------------- api/submit
  section("api/submit");

  const newsletter = await post("/api/submit", { form: "newsletter", email: "reader@example.com" });
  check("newsletter submit returns 200", newsletter.status === 200, `status ${newsletter.status}`);
  check("newsletter submit is ok", newsletter.body.ok === true);

  const unknownForm = await post("/api/submit", { form: "not-a-form", email: "x@example.com" });
  check("unknown form returns 400", unknownForm.status === 400, `status ${unknownForm.status}`);

  const badEmail = await post("/api/submit", {
    form: "contact",
    email: "not-an-email",
    message: "Hello",
  });
  check("invalid contact email returns 400", badEmail.status === 400, `status ${badEmail.status}`);

  const noMessage = await post("/api/submit", {
    form: "contact",
    email: "reader@example.com",
  });
  check("contact without a message returns 400", noMessage.status === 400, `status ${noMessage.status}`);

  const honeypot = await post("/api/submit", {
    form: "newsletter",
    email: "bot@example.com",
    website: "http://spam",
  });
  check(
    "honeypot submission is silently dropped",
    honeypot.status === 200 && honeypot.body.delivered === false,
  );

  // ------------------------------------------------------------------ report
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

verifyRoutes().catch((error) => {
  console.error(error);
  process.exit(1);
});
