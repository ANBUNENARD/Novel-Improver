/**
 * Mock Gemini `generateContent` server.
 *
 * Gemini does not speak the OpenAI protocol, so this stands in for it to prove
 * lib/llm.ts builds a valid generateContent request and reads a valid reply.
 * Failure modes are selected by the `x-mock-mode` header, matching the
 * OpenAI-shaped mock, so both providers can be driven through the same checks.
 *
 *   bun run scripts/mock-gemini.ts [port]
 *
 * Top-level bindings live inside `startMockGemini()` so they stay file-scoped;
 * the project type check otherwise treats these scripts as one shared global
 * scope, and same-named bindings in sibling scripts collide.
 */

async function startMockGemini() {
  const PORT = Number(process.argv[2]) || 4020;

  const CORRECTED = "It was a quiet morning. She received the letter, and it was not good news.";

  let currentMode = "ok";

  const server = Bun.serve({
    port: PORT,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/__mock/mode") {
        currentMode = url.searchParams.get("mode") ?? "ok";
        return Response.json({ mode: currentMode });
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

      const prompt = body.contents?.[0]?.parts?.map((part) => part.text ?? "").join("") ?? "";
      const passage = prompt.split("PASSAGE:")[1]?.trim() ?? "";

      return Response.json({
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  text: JSON.stringify({
                    corrected: passage || CORRECTED,
                    suggestions: [
                      {
                        category: "pov",
                        title: "Speaker name repeated on every line",
                        original: "Minjun said",
                        suggestion: "Minjun said",
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
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 },
      });
    },
  });

  console.log(`mock gemini listening on http://127.0.0.1:${server.port}`);
}

await startMockGemini();

export {};
