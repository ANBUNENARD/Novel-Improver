/**
 * Mock OpenAI-compatible chat-completions server.
 *
 * Speaks just enough of the protocol to exercise the real provider path in
 * lib/llm.ts: the request shape, the response shape, and parseModelOutput.
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

  const CORRECTED = "It was a quiet morning. She received the letter, and it was not good news.";

  /**
   * The last request's model, temperature, and bearer token. The browser suite
   * reads it back over `/__mock/last` to prove the key typed into the page is
   * the one that reached the provider.
   */
  let lastRequest: {
    model: string | null;
    temperature: number | null;
    bearer: string;
  } | null = null;

  /**
   * Mirrors what a real model does with fiction: it rewrites the prose but keeps
   * the user's characters, so dialogue and its speaker tags survive the round
   * trip. Without this the POV pass has nothing to attribute on this path.
   *
   * It also reports one continuity resolution, which is the other half of the
   * response contract the engine now depends on.
   */
  function buildPassageBody(passage: string) {
    return {
      id: "chatcmpl-mock",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "mock-model",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: JSON.stringify({
              corrected: passage,
              suggestions: [
                {
                  category: "pov",
                  title: "Speaker name repeated on every line",
                  original: "Minjun said",
                  note: "Minjun is named again immediately after speaking.",
                },
              ],
              continuity: [
                {
                  raw: "Mardol",
                  canonical: "Phine",
                  note: "Mardol is an alias the story has already established.",
                },
              ],
            }),
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    };
  }

  function buildBody() {
    return {
      id: "chatcmpl-mock",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "mock-model",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: JSON.stringify({
              corrected: CORRECTED,
              suggestions: [
                {
                  category: "grammar",
                  title: "Fix the verb form",
                  original: "It were",
                  suggestion: "It was",
                  note: "'It' takes the singular past tense 'was'.",
                },
                {
                  category: "spelling",
                  title: "Correct the spelling",
                  original: "recieved",
                  suggestion: "received",
                },
                {
                  category: "not-a-real-category",
                  title: "Unknown category is coerced",
                  original: "quiet morning",
                  suggestion: "still morning",
                },
                {
                  category: "clarity",
                  title: "No replacement, so this is dropped",
                },
              ],
            }),
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    };
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

    // What the last run actually sent. The browser suite reads this to prove
    // the key pasted into the page is the one that reached the provider, and
    // that a model chosen in the picker is the one that was asked for.
    if (url.pathname === "/__mock/last") {
      return Response.json({ last: lastRequest });
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

    lastRequest = {
      model: body.model ?? null,
      temperature: typeof body.temperature === "number" ? body.temperature : null,
      bearer: auth.slice("Bearer ".length),
    };

    if (!system.includes("verbatim substring") || !user.includes("PASSAGE:")) {
      return Response.json(
        { error: { message: "prompt contract not satisfied" } },
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

    // The continuity dictionary is optional, so this is a request-header check
    // rather than a contract: a run that sends one must carry the canonical
    // name, and a run that sends none must not mention the section at all.
    // The default is "expect one", because the editor always sends the saved
    // dictionary with the chapter. A suite that runs the engine directly with
    // none sets this to "0" before it starts.
    const carriesDictionary = user.includes("STORY CONTINUITY DICTIONARY");
    const expectDictionary =
      process.env.LLM_MOCK_EXPECT_DICTIONARY === "0" ? false : true;
    if (carriesDictionary !== expectDictionary) {
      return Response.json(
        { error: { message: `dictionary presence mismatch (${carriesDictionary})` } },
        { status: 400 },
      );
    }

    if (carriesDictionary && !user.includes("- Phine (female) = Phine Grancia = Mardol")) {
      return Response.json(
        { error: { message: "dictionary is missing the alias chain" } },
        { status: 400 },
      );
    }

    // Everything after the PASSAGE: header is the text the user pasted.
    const passage = user.slice(user.indexOf("PASSAGE:") + "PASSAGE:".length).trim();
    if (passage.includes('"')) return Response.json(buildPassageBody(passage));

    return Response.json(buildBody());
  },
});

  console.log(`[mock-provider] listening on http://127.0.0.1:${PORT}/v1`);
}

startMockProvider().catch((error) => {
  console.error(error);
  process.exit(1);
});
