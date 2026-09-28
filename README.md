# ProseLens

Paste a chapter, get it back as natural English.

A rephrasing tool for machine-translated novel chapters. You add your OpenAI key
at the top of the editor, pick a model, paste the chapter, and read the rewrite
on the right. The pasted text is never overwritten; the improved version is
assembled beside it, ready to copy or download. Built mobile-first and deployed
on Vercel.

---

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 15 (App Router only) |
| UI | React 19 |
| Language | TypeScript (strict) |
| Styling | Tailwind CSS v4 |
| Animation | GSAP + `@gsap/react` |
| Error monitoring | Sentry (`@sentry/nextjs`) — scaffolded, inert until a DSN is set |
| Build / package manager | Bun 1.3.4 |
| Runtime | Node 20 |
| Container | Docker, multi-stage, `node server.js` |

## Deployment

**Vercel is the primary target.** Next.js builds on Vercel with no configuration
beyond environment variables. Import the repo, set the env vars, deploy.

The Dockerfile and `output: "standalone"` exist for the optional Railway or
self-hosted path. Vercel ignores the Dockerfile entirely, so keeping both costs
nothing.

Railway picks up the `Dockerfile` as-is. The healthcheck probes `/api/health`.

---

## Getting started

```bash
bun install
cp .env.example .env.local
bun run dev
```

Open <http://localhost:3000>.

You do not need an API key in the file. Paste one into the field at the top of
the editor and it is kept in that browser. With no key on either side, a
built-in rules engine handles contractions, agreement errors, common
misspellings, duplicated words, spacing, and sentence length.

## Environment variables

See `.env.example` for the full annotated list. The essentials:

| Variable | Required | Purpose |
|---|---|---|
| `LLM_API_KEY` | No | Key for the model provider. A key pasted into the page is used instead when this is blank |
| `LLM_BASE_URL` | No | Any OpenAI-compatible endpoint. Defaults to `https://api.openai.com/v1` |
| `LLM_MODEL` | No | Model id used when the reader has not picked one in the app. Defaults to `gpt-4o-mini` |
| `LLM_TIMEOUT_MS` | No | Request timeout. Defaults to `60000` |
| `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` | No | Turns on error reporting |
| `WEBHOOK_URL_NEWSLETTER` | No | Where `/api/submit` sends newsletter signups |
| `WEBHOOK_URL_CONTACT` | No | Contact form relay |
| `WEBHOOK_URL_WAITLIST` | No | Waitlist relay |
| `WEBHOOK_URL_SCHEDULE` | No | Scheduling form relay |
| `NEXT_PUBLIC_SITE_URL` | No | Absolute URLs in metadata |

### Any OpenAI-compatible provider

Point `LLM_BASE_URL` at whichever provider you use:

```bash
LLM_BASE_URL=https://api.x.ai/v1          LLM_MODEL=grok-4
LLM_BASE_URL=https://openrouter.ai/api/v1 LLM_MODEL=anthropic/claude-sonnet-4
LLM_BASE_URL=https://api.groq.com/openai/v1
LLM_BASE_URL=http://localhost:11434/v1    LLM_MODEL=llama3.1   # Ollama
```

The key stays server-side and is never bundled into the client.

### Your API key

There are two ways to supply a key, and they do not conflict:

- **Paste it into the page.** The field labelled `OpenAI key`, at the top of
  the editor, is masked, has a Show toggle, and keeps the value in that
  browser's local storage under `proselens:apiKey`. It is posted with each run
  as `apiKey` and used for that request alone. It is never written to a file or
  a log, and Clear removes it.
- **Set `LLM_API_KEY` in the environment.** A key set there takes precedence, so
  a hosted deployment never needs a key in anyone's browser.

`lib/credentials.ts` builds the request config. The provider, base URL, and
timeout stay server-side settings, so a pasted key can only ever be used
against the endpoint this app is configured for.

### Choosing a model per run

The model row sits under the key field. It lists only the models the configured
provider can serve — the GPT models for an OpenAI key, the Gemini models for a
Gemini key — and whatever you select is sent with that request. The list is
served whether or not a key is set, so the choice is available before you
paste one.

Each chip carries its real price, because the models differ by two orders of
magnitude in cost:

| Model | Input / output per 1M tokens |
|---|---|
| `gpt-5-nano` | $0.05 / $0.40 |
| `gpt-4.1-nano` | $0.10 / $0.40 |
| `gpt-4o-mini` | $0.15 / $0.60 |
| `gpt-5-mini` | $0.25 / $2.00 |
| `gpt-4.1-mini` | $0.40 / $1.60 |
| `gpt-4.1` | $2.00 / $8.00 |
| `gpt-4o` | $2.50 / $10.00 |

OpenAI bills all of these per token and has no ongoing free tier. A new account
gets roughly $5 of one-time credits and needs a payment method attached. A
60,000-character chapter is about 15,000 tokens, so a full chapter on
`gpt-5-nano` costs around one cent. The two Gemini entries are the ones with a
genuine free tier, and they need a Google AI Studio key.

The GPT-5 models accept only the default temperature and answer 400 for
anything else, so `lib/llm.ts` sends no `temperature` for them. The flag on
each entry in `MODEL_CHOICES` drives that, and `FIXED_TEMPERATURE_MODELS` is
derived from the same list, so a model cannot be added to the picker without
being handled.

With nothing selected, `LLM_MODEL` sets the default. On a server with no
`LLM_MODEL`, the cheapest model runs, which is what a reader pasting a key for
the first time gets. With no key anywhere, the built-in rules engine handles
the pass.

---

## Routes

| Route | Purpose |
|---|---|
| `/` | Landing page and the editor |
| `/api/correct` | `POST` — runs the correction pipeline |
| `/api/health` | `GET` — liveness probe, reports whether the LLM is configured and which models it can reach |
| `/api/submit` | `POST` — relays forms to the matching webhook |
| 404 | Not-found page |

## Scripts

```bash
bun run dev            # dev server
bun run build          # production build
bun run start          # serve the production build
bun run typecheck      # tsc --noEmit
bun run lint           # eslint
bun run test:engine    # 109 engine tests, no network or API key needed
bun run test:quality   # 16 quality checks against a running dev server
bun run test:routes    # 85 HTTP checks against a running server
bun run test:llm       # 47 provider checks against the bundled mock
bun run test:gemini    # 32 checks against the Gemini-shaped mock
bun run test:ui        # 51 browser checks in headless Chrome
```

### Browser verification

`test:ui` drives a real headless Chrome over the DevTools protocol: it types
into the textarea, clicks the chips, runs the check, and asserts on the rendered
result at 1280x900 and 390x844. It throws away its browser profile afterwards, so
it never touches your real Chrome data. It writes two screenshots to `scripts/`
so a failed run can be looked at. Chrome and Edge are both picked up
automatically.

If you serve the production build locally, copy `.next/static` into
`.next/standalone/.next/static` first. The standalone output leaves the client
bundle out on purpose, and the Dockerfile does that copy as a separate step.

### Route verification

The route suite needs a running server:

```bash
bun run dev &                                  # plain, no API key
bun run scripts/verify-routes.ts               # 85 checks against :3000
```

To exercise the provider path without a real key, run the bundled mock and a
second server pointed at it:

```bash
bun run scripts/mock-provider.ts               # fake OpenAI-compatible API on :4010
LLM_BASE_URL=http://127.0.0.1:4010/v1 \
LLM_API_KEY=test \
LLM_MODEL=gpt-4o-mini \
NEXT_DIST_DIR=.next-mock \
bun run dev -- --port 3001 &                   # separate build dir

bun run scripts/verify-llm-path.ts http://127.0.0.1:3001
```

`NEXT_DIST_DIR` keeps the two dev servers from clobbering each other's build
output. The mock rejects any request that does not satisfy the prompt contract,
so a passing run also proves the system prompt and payload shape are correct.

---

## How the correction pipeline works

`lib/engine.ts` orchestrates two paths:

1. **LLM path** — when a key is available, either from the request or the
   environment, `lib/llm.ts` sends the passage with the master prompt and parses
   the JSON response.
2. **Local path** — `lib/local-engine.ts` applies high-confidence rules only. It
   never guesses at style.

A provider failure (bad key, timeout, unparseable response, HTTP error) falls
back to the local engine and reports the reason in `fallbackReason`, which the
UI surfaces. The editor always renders a result; it never hard-fails.

The editor runs the pipeline at fixed settings. Tone is `polished`, point of
view is `detect`, and every issue category is checked. The components for
choosing those are still in the tree, along with the pipeline strip, speaker
list, continuity list, summary strip, suggestion cards, and the story-bible
panel, which currently ship in the source but are not rendered — re-rendering
any of them is a matter of adding the element back to `components/editor/editor.tsx`.

### Your chapter is never deleted

The left box holds exactly what you pasted, for the whole session. The improved
version is assembled on the right, and you can copy or download it whenever you
are happy with the result. Nothing is written to your draft unless you ask for
it.

### Who is talking

`lib/pov.ts` runs on every path, provider or not, because speaker attribution is
settled from the text alone and a model does not reliably track a cast across a
whole chapter. It works out who speaks each quoted line from the dialogue tag,
the narration beat before it, or the previous line in the same exchange, and
reports which of those it used so you can judge the finding yourself.

It runs in `detect` mode for every paste, so no text is changed on the speaker's
account. The engine also supports `off` (no analysis) and `enforce` (also
removes the tag on a character who has just spoken), which is the
translated-Korean-webnovel pattern of naming the speaker on every single line.

### Your story bible

A machine-translated chapter gets names wrong, and the mistakes read like new
characters. A continuity dictionary declares the cast once: name, aliases,
gender, kind, and role. It ships with the sample cast from the workflow
document, so the first run already knows that `Mardol` and `Phine Grancia` are
Phine, and that `Licht` and `Lee Soo-hyun` are the same man.

Two things follow from an entry:

- **Before the model reads the chapter**, `lib/story-bible.ts` rewrites any alias
  to its canonical name, so the prompt never contains a transliteration variant.
  The original wording of your draft on the left is never altered.
- **In the result**, every name it matched is reported back with the variant and
  the canonical name it resolved to.

Entries live in the reader's browser under `proselens:story-bible:v1` and are
sent with each check. Nothing is stored on the server. The panel that edited
them is not currently rendered; the entries it wrote are still read and sent.
`lib/default-bible.ts` also exposes `parseBibleText`, so a dictionary can be
pasted in one entry per line, with a heading such as `CHARACTERS:` setting the
kind for the lines beneath it.

```
CHARACTERS:
Phine: female = Phine Grancia = Mardol; Glass Knight
Kainel: male; Hero
LOCATIONS:
Temple of Tarden
```

### The ten stages

The pass runs in ten stages, and `lib/pipeline.ts` reports what each one did on
this chapter. The report is built from what actually ran, so a stage that found
nothing says nothing to fix and the rewrite stage never claims a rewrite that
did not happen. The strip that renders it is in the source but not currently
drawn on the page.

| # | Stage | What it reports |
|---|---|---|
| 1 | Parse | Paragraph and quoted-line counts |
| 2 | POV | Lines attributed, and how many stayed unclear |
| 3 | Names | Names matched to the story bible |
| 4 | Continuity | The alias variants that were resolved, by name |
| 5 | Meaning | Passages read for the author's intended meaning |
| 6 | Rewrite | What the engine did to the prose |
| 7 | Pacing | Paragraphs out and average sentence length |
| 8 | Dialogue | Attributions corrected, or lines reading cleanly |
| 9 | Logic | Sequences reordered or flagged |
| 10 | Final check | The closing consistency pass |

### Files

| File | Role |
|---|---|
| `lib/types.ts` | The contract shared by API, engine, and UI |
| `lib/text-stats.ts` | Word/sentence counts, Flesch readability, sentence splitter |
| `lib/model-output.ts` | Validates and normalises provider JSON |
| `lib/validate.ts` | Request validation, model allowlist, key cleanup (pure, no server-only) |
| `lib/credentials.ts` | Builds a request config from a key the reader pasted |
| `lib/llm.ts` | Provider transport and the web-novel master prompt |
| `lib/pov.ts` | Dialogue extraction, speaker attribution, POV rewrites |
| `lib/story-bible.ts` | Dictionary parsing, alias normalisation, prompt formatting |
| `lib/default-bible.ts` | The shipped sample cast and the paste-a-dictionary parser |
| `lib/pipeline.ts` | The ten-stage report |
| `lib/local-engine.ts` | Deterministic offline correction rules |
| `lib/engine.ts` | Chooses between the two paths |

---

## Privacy

The chapter is sent to the configured provider for a single pass and discarded.
A key pasted into the page stays in that browser's local storage and is never
written to a database or a log; no manuscript content and no key reach Sentry —
the `beforeSend` hook strips request bodies and cookies. The site works with no
account and no cookies.
