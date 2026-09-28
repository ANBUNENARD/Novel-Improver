/**
 * Mock Gemini `generateContent` server.
 *
 * Gemini does not speak the OpenAI protocol, so this stands in for it to prove
 * lib/llm.ts builds a valid generateContent request and reads a valid reply.
 * It answers both passes: the analyst prompt with a list of findings, the
 * rewriter prompt with the finished chapter.
 *
 * The request is rejected when it breaks the prompt contract, so a 200 through
 * the app also proves the system instruction, the user prompt, and the reply
 * envelope all line up. That mirrors what scripts/mock-provider.ts does for the
 * OpenAI transport, so both providers are held to the same bar.
 *
 * Failure modes are selected by the `x-mock-mode` header or by `__mock/mode`,
 * matching the OpenAI-shaped mock, so both providers can be driven through the
 * same checks.
 *
 *   bun run scripts/mock-gemini.ts [port]
 *
 * Top-level bindings live inside `startMockGemini()` so they stay file-scoped;
 * the project type check otherwise treats these scripts as one shared global
 * scope, and same-named bindings in sibling scripts collide.
 */

async function startMockGemini() {
  const PORT = Number(process.argv[2]) || 4020;

  let currentMode = "ok";
  let expectDictionary = false;

  /** The prompts this mock was last asked to answer, most recent last. */
  const log: Array<{ pass: string; model: string | null; hasDictionary: boolean }> = [];

  function json(content: unknown) {
    return Response.json({
      candidates: [
        {
          content: { role: "model", parts: [{ text: JSON.stringify(content) }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 },
    });
  }

  /** Findings placed on the paragraph that actually contains their phrase. */
  function buildAnalysis(passage: string) {
    const paragraphs = passage.split(/\n{2,}/).filter(Boolean);

    /** The index of the paragraph a phrase is in, or -1 when it is absent. */
    const where = (phrase: string) => paragraphs.findIndex((part) => part.includes(phrase));

    const found: Array<{ at: number; note: Record<string, unknown> }> = [];
    const add = (phrase: string, note: (at: number) => Record<string, unknown>) => {
      const at = where(phrase);
      if (at !== -1) found.push({ at, note: note(at) });
    };

    add("It were", () => ({
      category: "grammar",
      title: "Fix the verb form",
      excerpt: "It were",
      intended: "'It' takes the singular past tense 'was'.",
      rewrite: "It was",
    }));

    add("recieved", () => ({
      category: "spelling",
      title: "Correct the spelling",
      excerpt: "recieved",
      intended: "The word is 'received'.",
      rewrite: "received",
    }));

    add("The the", () => ({
      category: "not-a-real-category",
      title: "Unknown category is coerced",
      excerpt: "The the",
      intended: "A machine translation repeats the article; one is enough.",
      rewrite: "The",
    }));

    // The repeated speaker tag is what a machine translation leaves behind, and
    // reporting it is the one thing the POV layer is asked to catch.
    add("Minjun said.", () => ({
      category: "pov",
      title: "Drop the repeated speaker tag",
      excerpt: "Minjun said.",
      intended: "The narration already established who is speaking.",
      rewrite: "",
    }));

    return {
      notes: found.map(({ at, note }) => ({ paragraph: at, ...note })),
      // The alias is reported only when the passage actually contains it, so
      // the resolution reaches the reader only when there is one to make.
      continuity: passage.includes("Mardol")
        ? [
            {
              raw: "Mardol",
              canonical: "Phine",
              note: "Mardol is an alias the story has already established.",
            },
          ]
        : [],
    };
  }

  /**
   * Applies the analyst's rewrites to the passage.
   *
   * A finding with a `rewrite` replaces its excerpt in place; one without only
   * records the reading, so the paragraph is left as the author wrote it. This
   * is what makes a paragraph read as changed in the side-by-side view.
   */
  function applyFindings(passage: string, prompt: string) {
    let text = passage;

    for (const match of prompt.matchAll(/^- Paragraph \d+ \[\w+\] [^.]+\. Meant: [^"]*"([^"]+)" -> "([^"]+)"$/gm)) {
      const [, excerpt, rewrite] = match;
      if (excerpt && rewrite) text = text.replace(excerpt, rewrite);
    }

    return text;
  }

  const server = Bun.serve({
    port: PORT,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/__mock/mode") {
        currentMode = url.searchParams.get("mode") ?? "ok";
        return Response.json({ mode: currentMode });
      }

      if (url.pathname === "/__mock/expect-dictionary") {
        expectDictionary = url.searchParams.get("value") === "1";
        return Response.json({ expectDictionary });
      }

      if (url.pathname === "/__mock/reset") {
        log.length = 0;
        return Response.json({ ok: true });
      }

      if (url.pathname === "/__mock/last") {
        return Response.json({ requests: log });
      }

      let mode = currentMode;
      const header = request.headers.get("x-mock-mode");
      if (header) mode = header;

      if (mode === "http500") {
        return new Response("upstream exploded", { status: 500 });
      }
      if (mode === "http401") {
        return new Response(JSON.stringify({ error: { message: "API key not valid" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (mode === "nonsense") {
        return Response.json({
          candidates: [
            {
              content: {
                parts: [{ text: "I think this chapter reads reasonably well overall." }],
              },
            },
          ],
        });
      }

      const body = (await request.json()) as {
        systemInstruction?: { parts?: Array<{ text?: string }> };
        contents?: Array<{ parts?: Array<{ text?: string }> }>;
        generationConfig?: { responseMimeType?: string };
      };

      const system = body.systemInstruction?.parts?.[0]?.text ?? "";
      const prompt = body.contents?.[0]?.parts?.map((part) => part.text ?? "").join("") ?? "";

      // The two prompts are told apart by what they ask for, which is also how
      // lib/llm.ts and the OpenAI mock tell them apart.
      const pass = system.includes('"intended"') ? "analyst" : "rewriter";

      // The chapter is the tail of both prompts. The analyst's is introduced by
      // a `PASSAGE:` marker, but the rewriter's findings come first and the
      // marker only opens the chapter, so the last one is read rather than the
      // first.
      const marker = prompt.lastIndexOf("PASSAGE:");
      const passage = (marker === -1 ? "" : prompt.slice(marker + "PASSAGE:".length)).trim();

      log.push({
        pass,
        model: url.pathname.split("/models/")[1]?.split(":")[0] ?? null,
        hasDictionary: prompt.includes("STORY CONTINUITY DICTIONARY"),
      });

      // The dictionary belongs to the analyst pass only. The rewriter is given
      // the analyst's findings instead, so sending it the raw dictionary would
      // put the same facts in front of the model twice.
      const carriesDictionary = prompt.includes("STORY CONTINUITY DICTIONARY");
      if (pass === "analyst" && carriesDictionary !== expectDictionary) {
        const head = prompt.slice(0, 400);
        return Response.json({ error: { message: `dictionary presence mismatch (${carriesDictionary})`, head } }, { status: 400 });
      }

      // A request with no readable chapter is a transport the app got wrong,
      // so it is rejected rather than answered.
      if (passage.length === 0) {
        return Response.json({ error: { message: "no passage in the prompt" } }, { status: 400 });
      }

      if (pass === "analyst" && carriesDictionary) {
        const shape = [/- Phine \(female\) = Phine Grancia = Mardol/];
        if (!shape.every((line) => line.test(prompt))) {
          const seen = prompt.match(/^- .*$/gm)?.slice(0, 8) ?? [];
          return Response.json({ error: { message: `dictionary is missing its alias chain; saw ${JSON.stringify(seen)}` } }, { status: 400 });
        }
      }

      return json(pass === "analyst" ? buildAnalysis(passage) : { corrected: applyFindings(passage, prompt) });
    },
  });

  console.log(`mock gemini listening on http://127.0.0.1:${server.port}`);
}

await startMockGemini();

export {};
