/**
 * Mock OpenAI-compatible chat-completions server.
 *
 * Speaks just enough of the protocol to exercise the real provider path in
 * lib/llm.ts across both passes: the request shape, the response shape, and
 * the two parsers in lib/model-output.ts. It answers the analyst prompt with a
 * list of findings and the rewriter prompt with the finished chapter, which is
 * what lib/llm.ts sends and expects.
 *
 * Also serves a couple of failure modes selected by the `x-mock-mode` header or
 * the LLM_MOCK_MODE env var, so the fallback path can be proven too.
 *
 *   bun run scripts/mock-provider.ts [port]
 *
 * Top-level bindings live inside `startMockProvider()` so they stay file-scoped;
 * the project type check otherwise treats these scripts as one shared global
 * scope, and same-named bindings in sibling scripts collide.
 */

async function startMockProvider() {
  const PORT = Number(process.argv[2]) || 4010;

  const usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };

  function envelope(content: string) {
    return {
      id: "chatcmpl-mock",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "mock-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage,
    };
  }

  /**
   * Every request this server has seen, in order. The verification suite reads
   * them back over `/__mock/last` to prove the key typed into the page is the
   * one that reached the provider, that the model chosen in the picker is the
   * one that was asked for, and that the chapter really was sent twice.
   */
  const requests: Array<{
    pass: "analyst" | "rewriter";
    model: string | null;
    temperature: number | null;
    bearer: string;
    dictionary: boolean;
  }> = [];

  /**
   * Whether the next request is expected to carry a continuity dictionary.
   *
   * Kept as a local binding rather than in the environment: the control
   * endpoint sets it, the request handler reads it, and a variable survives
   * between requests without going anywhere a handler cannot see.
   */
  let expectDictionary = false;

  /**
   * Findings spread across the passage, one per paragraph where there is more
   * than one. A model reads a chapter in full, so its notes are not all stacked
   * on the opening paragraph.
   *
   * Phrases are drawn from the passage where it contains them, and each finding
   * names the paragraph that phrase is actually in, because that is the contract
   * the rewriter prompt is built on: a finding placed on the wrong paragraph
   * sends the rewrite to the wrong place, and the reader is shown a rewrite
   * beside a sentence it has nothing to do with.
   */
  function buildAnalysis(passage: string) {
    const paragraphs = passage.split(/\n{2,}/).filter(Boolean);

    /** The index of the paragraph a phrase is in, or -1 when it is absent. */
    const where = (phrase: string) => paragraphs.findIndex((part) => part.includes(phrase));

    const found: Array<{ at: number; note: Record<string, unknown> }> = [];
    const add = (phrase: string, note: (at: number) => Record<string, unknown>) => {
      const at = where(phrase);
      if (at !== -1) found.push({ at, note: note(at) });
    };

    add("It have", (at) => ({
      category: "grammar",
      title: "Fix the verb form",
      excerpt: "It have",
      intended: "'It' takes the singular present tense 'has'.",
      rewrite: "It has",
    }));

    add("It were", (at) => ({
      category: "grammar",
      title: "Fix the verb form",
      excerpt: "It were",
      intended: "'It' takes the singular past tense 'was'.",
      rewrite: "It was",
    }));

    add("recieved", (at) => ({
      category: "spelling",
      title: "Correct the spelling",
      excerpt: "recieved",
      intended: "The word is 'received'.",
      rewrite: "received",
    }));

    add("becoming embarrassed", (at) => ({
      category: "spelling",
      title: "Correct the spelling",
      excerpt: "becoming embarrassed",
      intended: "The verb is 'grew'; the phrase is not a misspelling of a word but a machine rendering.",
      rewrite: "grew",
    }));

    // The repeated speaker tag is what a machine translation leaves behind, and
    // reporting it is the one thing the POV layer is asked to catch.
    add("Minjun said.", () => ({
      category: "pov",
      title: "Drop the repeated speaker tag",
      excerpt: "Minjun said.",
      intended: "The narration has already established who is speaking.",
      rewrite: "",
    }));

    // A category the app does not know, so the coercion of an unknown label to a
    // real one is exercised wherever the phrase sits.
    add("The the", (at) => ({
      category: "not-a-real-category",
      title: "Unknown category is coerced",
      excerpt: "The the",
      intended: "A machine translation repeats the article; one is enough.",
      rewrite: "The",
    }));

    add("very quiet", (at) => ({
      category: "not-a-real-category",
      title: "Unknown category is coerced",
      excerpt: "very quiet",
      intended: "The scene reads better as a still moment.",
      rewrite: "still",
    }));

    return JSON.stringify({
      notes: [
        ...found.map(({ at, note }) => ({ paragraph: at, ...note })),
        {
          paragraph: 0,
          category: "clarity",
          title: "No excerpt, so this is dropped",
          excerpt: "",
          intended: "This cannot be tied to a place in the passage.",
          rewrite: "",
        },
      ],
      continuity: [],
    });
  }

  /**
   * Applies the analyst's proposed rewrites to the passage, which is what the
   * rewrite prompt asks for: a phrase is replaced in place, and a finding with
   * no phrase leaves the paragraph alone.
   *
   * Echoing the passage rather than inventing prose is what lets the speaker
   * pass have something to attribute on the provider path, and it keeps the
   * paragraph count intact so the pairing has a real shape to work with.
   */
  function applyFindings(passage: string, user: string): string {
    let result = passage;
    const findings = user.matchAll(/^- Paragraph \d+ \[[^\]]+\][^\n]*?"([^"]*)" -> "([^"]*)"$/gm);

    for (const finding of findings) {
      const [, excerpt, rewrite] = finding;
      if (excerpt) result = result.split(excerpt).join(rewrite);
    }

    return result;
  }

  /**
   * The text the reader pasted is everything after the final `PASSAGE:` header
   * in whichever pass is running. Both passes end the same way, and the analyst
   * gets the raw chapter, so the last occurrence is the one to read.
   */
  function passageOf(user: string): string {
    const header = "PASSAGE:";
    return user.slice(user.lastIndexOf(header) + header.length).trim();
  }

  Bun.serve({
    port: PORT,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/__mock/health") {
        return Response.json({ ok: true, mode: process.env.LLM_MOCK_MODE ?? "ok" });
      }

      // Lets the verification script switch failure modes at runtime, since it
      // runs in a different process from this server.
      if (url.pathname === "/__mock/mode") {
        const mode = url.searchParams.get("mode") ?? "ok";
        process.env.LLM_MOCK_MODE = mode;
        return Response.json({ mode });
      }

      // The same reasoning applies to the dictionary contract: the flag is read
      // here, where the request is judged, so it is set over HTTP rather than in
      // the caller's environment.
      if (url.pathname === "/__mock/expect-dictionary") {
        expectDictionary = (url.searchParams.get("value") ?? "1") === "1";
        return Response.json({ value: expectDictionary });
      }

      // How many paragraphs the next paste is expected to have. The analyst
      // reads the passage and places each finding on the paragraph its phrase is
      // in, so this is answered rather than stored: a suite that wants a
      // multi-paragraph paste sends one, and the findings follow the text.
      if (url.pathname === "/__mock/expect-paragraphs") {
        const value = Math.max(1, Number(url.searchParams.get("value")) || 1);
        return Response.json({ value });
      }

      // Clears the log so a check can read exactly the requests one run made.
      if (url.pathname === "/__mock/reset") {
        requests.length = 0;
        return Response.json({ ok: true });
      }

      // What the last run actually sent. The browser suite reads this to prove
      // the key pasted into the page is the one that reached the provider, and
      // that a model chosen in the picker is the one that was asked for.
      if (url.pathname === "/__mock/last") {
        return Response.json({ last: requests[requests.length - 1] ?? null, requests });
      }

      if (!url.pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }

      const auth = request.headers.get("Authorization");
      if (!auth?.startsWith("Bearer ")) {
        return Response.json({ error: { message: "missing bearer token" } }, { status: 401 });
      }

      const mode = request.headers.get("x-mock-mode") ?? process.env.LLM_MOCK_MODE ?? "ok";

      if (mode === "unauthorized") {
        return Response.json({ error: { message: "invalid api key" } }, { status: 401 });
      }

      if (mode === "garbage") {
        return Response.json({
          choices: [{ message: { role: "assistant", content: "sorry, I cannot do that" } }],
        });
      }

      if (mode === "empty") {
        return Response.json({ choices: [{ message: { role: "assistant", content: "" } }] });
      }

      // Confirm the engine sends what the prompt contract promises.
      const body = (await request.json()) as {
        model?: string;
        temperature?: number;
        response_format?: { type?: string };
        messages?: Array<{ role: string; content: string }>;
      };

      const system = body.messages?.find((message) => message.role === "system")?.content ?? "";
      const user = body.messages?.find((message) => message.role === "user")?.content ?? "";

      // The two prompts are told apart by what they ask for, which is also how
      // lib/llm.ts tells them apart.
      const pass: "analyst" | "rewriter" = system.includes("Return raw JSON only. No markdown")
        ? system.includes('"intended"')
          ? "analyst"
          : "rewriter"
        : "rewriter";

      requests.push({
        pass,
        model: body.model ?? null,
        temperature: typeof body.temperature === "number" ? body.temperature : null,
        bearer: auth.slice("Bearer ".length),
        dictionary: user.includes("STORY CONTINUITY DICTIONARY"),
      });

      if (!user.includes("PASSAGE:")) {
        return Response.json(
          { error: { message: "prompt contract not satisfied" } },
          { status: 400 },
        );
      }

      if (pass === "analyst" && !system.includes("EVIDENCE")) {
        return Response.json(
          { error: { message: "the analyst prompt did not arrive" } },
          { status: 400 },
        );
      }

      if (pass === "rewriter" && !system.includes("WEB-NOVEL STYLE")) {
        return Response.json(
          { error: { message: "the rewriter prompt did not arrive" } },
          { status: 400 },
        );
      }

      // The reasoning models accept only the default temperature and answer 400
      // for anything else, so a run that sends one here must have left it off.
      if ((body.model ?? "").startsWith("gpt-5") && typeof body.temperature === "number") {
        return Response.json(
          {
            error: {
              message: `Unsupported value: 'temperature' does not support ${body.temperature} with this model. Only the default (1) is supported.`,
            },
          },
          { status: 400 },
        );
      }

      // A model that does take a temperature should be sent one, or the rewriting
      // is not held stable between runs.
      if (!(body.model ?? "").startsWith("gpt-5") && typeof body.temperature !== "number") {
        return Response.json(
          { error: { message: "temperature missing on a model that accepts it" } },
          { status: 400 },
        );
      }

      // The continuity dictionary is optional, so this is a request-shape check
      // rather than a contract. It belongs to the analyst pass alone: that is
      // the pass asked to read the chapter against the dictionary, while the
      // rewriter is handed the analyst's findings and never sees the raw text
      // the names came from. A suite asks for the expectation it wants through
      // `/__mock/expect-dictionary`, and the check defaults off so a mock left
      // running after one suite cannot reject the next suite's requests.
      const carriesDictionary = user.includes("STORY CONTINUITY DICTIONARY");
      if (pass === "analyst" && carriesDictionary !== expectDictionary) {
        const head = user.slice(0, 400);
        return Response.json(
          { error: { message: `dictionary presence mismatch (${carriesDictionary})`, head } },
          { status: 400 },
        );
      }

      // A dictionary that reaches the analyst has to reach it in the shape the
      // prompt format produces. The chapter fixture resolves a name through an
      // alias, a name that carries a gender and a role, and a place, so one
      // line of each proves the format survives the trip: name, gender, alias,
      // and the role that follows the aliases.
      if (pass === "analyst" && carriesDictionary) {
        const shape = [
          /^- Lee Soo-hyun \(male\) = Soo-hyun/m,
          /^- Mardol \(female\) \| /m,
          /^- Temple of Tarden$/m,
        ];

        if (!shape.every((line) => line.test(user))) {
          const seen = user.match(/^- .*$/gm)?.slice(0, 8) ?? [];
          return Response.json(
            { error: { message: `dictionary is missing its alias chain; saw ${JSON.stringify(seen)}` } },
            { status: 400 },
          );
        }
      }

      const passage = passageOf(user);

      // A chapter is rewritten whole, dialogue included. A run that carries
      // quoted lines still has narration around them, and returning only the
      // dialogue would drop most of the chapter, so the findings are applied to
      // the passage as it stands and the speaker pass is left to the engine,
      // which does that job from the text rather than from the model.
      if (pass === "analyst") {
        return Response.json(envelope(buildAnalysis(passage)));
      }

      return Response.json(
        envelope(JSON.stringify({ corrected: applyFindings(passage, user) })),
      );
    },
  });

  console.log(`[mock-provider] listening on http://127.0.0.1:${PORT}/v1`);
}

startMockProvider().catch((error) => {
  console.error(error);
  process.exit(1);
});
