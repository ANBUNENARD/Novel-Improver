/**
 * Drives the editor in a real browser to verify the whole reader flow: paste a
 * key, pick a model, paste a chapter, read the rewrite.
 *
 *   bun run scripts/verify-ui.ts http://127.0.0.1:3002
 *
 * The server this runs against must have no key of its own, so the key the
 * browser sends is provably the one that reached the provider. The mock at
 * 4010 reports back what it received on /__mock/last.
 *
 * Uses a throwaway profile with a dedicated temp dir, so it never touches the
 * user's real Chrome data. Screenshots land next to this file.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] || "http://127.0.0.1:3002";
const MOCK = "http://127.0.0.1:4010";
// The editor always sends the saved character dictionary with the chapter, so
// the mock is told to expect one before any run reaches it.
const DICTIONARY_ENDPOINT = `${MOCK}/__mock/mode?mode=ok`;
const PASTED_KEY = "sk-proj-typed-into-the-browser";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

function pickBrowser() {
  for (const candidate of [CHROME, EDGE]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("no Chromium browser found");
}

/**
 * A chapter of narration. The mock answers a passage containing dialogue by
 * echoing it back, so a prose rewrite is what proves the output came from the
 * provider rather than from a rules engine that happened to agree.
 */
const PASSAGE = "It were a quiet morning and she had recieved the letter that morning.";

let passed = 0;
let failed = 0;
const problems: string[] = [];

function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    problems.push(name);
    console.error(`  FAIL ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

/** Whatever the DevTools endpoint sends back, narrowed to what is read here. */
interface DevtoolsMessage {
  id?: number;
  result?: Record<string, unknown>;
  method?: string;
  params?: {
    type?: string;
    args?: Array<{ value?: unknown; description?: string; type?: string }>;
    exceptionDetails?: { exception?: { description?: string } };
  };
  sessionId?: string;
}

async function main() {
  const profile = mkdtempSync(join(tmpdir(), "proselens-chrome-"));
  const browser = pickBrowser();
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=9222",
  ];

  const chrome = Bun.spawn([browser, ...args], { stdout: "ignore", stderr: "ignore" });
  const cleanup = () => {
    try {
      chrome.kill();
    } catch {
      // already gone
    }
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // best effort
    }
  };

  try {
    // Put the mock in a known state: a clean run, and a dictionary expected,
    // since the editor sends one on every run.
    await fetch(DICTIONARY_ENDPOINT);

    // Wait for the DevTools endpoint.
    let wsUrl = "";
    for (let i = 0; i < 60 && !wsUrl; i++) {
      try {
        const list = (await (await fetch("http://127.0.0.1:9222/json/list")).json()) as Array<{
          webSocketDebuggerUrl?: string;
        }>;
        wsUrl = list.find((t) => t.webSocketDebuggerUrl)?.webSocketDebuggerUrl ?? "";
      } catch {
        // not up yet
      }
      if (!wsUrl) await new Promise((r) => setTimeout(r, 500));
    }
    if (!wsUrl) throw new Error("Chrome DevTools endpoint never came up");

    const socket = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("devtools socket failed"));
    });

    let nextId = 1;
    const pending = new Map<number, (value: DevtoolsMessage) => void>();
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    let sessionId = "";

    socket.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as DevtoolsMessage;
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
        return;
      }
      if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
        consoleErrors.push(
          (msg.params.args ?? [])
            .map((a) => String(a.value ?? a.description ?? a.type))
            .join(" "),
        );
      }
      if (msg.method === "Runtime.exceptionThrown") {
        pageErrors.push(msg.params?.exceptionDetails?.exception?.description ?? "exception");
      }
    };

    const send = (method: string, params: Record<string, unknown> = {}, sid = sessionId) =>
      new Promise<DevtoolsMessage>((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        socket.send(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) }));
      });

    // Attach to a fresh tab.
    const attached = await send("Target.createTarget", { url: "about:blank" }, "");
    const targetId = String(attached.result?.targetId ?? "");
    const attachedSession = await send(
      "Target.attachToTarget",
      { targetId, flatten: true },
      "",
    );
    sessionId = String(attachedSession.result?.sessionId ?? "");

    await send("Page.enable");
    await send("Runtime.enable");
    await send("Log.enable");

    const evaluate = async (expression: string) => {
      const res = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      const details = res.result?.exceptionDetails as
        | { exception?: { description?: string } }
        | undefined;
      if (details) {
        throw new Error(details.exception?.description ?? "eval failed");
      }
      const value = (res.result?.result as { value?: unknown } | undefined)?.value;
      return value;
    };

    const gotoAsync = async (url: string) => {
      await send("Page.navigate", { url });
      const deadline = Date.now() + 20000;
      for (;;) {
        const state = await evaluate("document.readyState");
        if (state === "complete") return;
        if (Date.now() > deadline) throw new Error(`timed out loading ${url}`);
        await new Promise((r) => setTimeout(r, 300));
      }
    };

    const clickByText = async (selector: string, text: string) => {
      const ok = await evaluate(`(() => {
        const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
          .find((n) => n.textContent.trim() === ${JSON.stringify(text)});
        if (!el) return false;
        el.click();
        return true;
      })()`);
      if (!ok) throw new Error(`no ${selector} labelled "${text}"`);
    };

    const setValue = (selector: string, value: string) =>
      evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const proto = el.tagName === 'TEXTAREA'
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return el.value.length;
      })()`);

    /**
     * The page ships static HTML, so a click before React hydrates hits nothing.
     * Typing and watching the word counter move proves the handlers are live.
     */
    const waitForReact = async () => {
      const deadline = Date.now() + 20000;
      for (;;) {
        // React tags every managed DOM node with a fiber key, so that is the
        // surest sign the client bundle has taken over.
        const hydrated = await evaluate(
          `Object.getOwnPropertyNames(document.getElementById('draft') || {})
            .some((k) => k.indexOf('reactFiber') >= 0 || k.indexOf('reactProps') >= 0)`,
        );
        if (hydrated === true) return;
        if (Date.now() > deadline) {
          const visible = await pageText();
          throw new Error(
            `react never hydrated. text: ${visible.slice(0, 300)} | errors: ${[...consoleErrors, ...pageErrors].join(" | ").slice(0, 500)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    };

    const type = (value: string) => setValue("#draft", value);

    const pageText = () => evaluate("document.body.innerText") as Promise<string>;

    /**
     * Waits for the run to settle.
     *
     * The spinner is the only thing on the page while the request is in flight,
     * and it is replaced by the paragraph cards either way, so both outcomes are
     * caught by watching for its disappearance. Falling back on the error alert
     * is what keeps a rejected run from sitting here until the deadline.
     */
    const runCheck = async () => {
      await clickByText("button", "Improve this chapter");
      const deadline = Date.now() + 30000;
      for (;;) {
        const state = await evaluate(`(() => {
          const live = document.querySelector('section[aria-live]');
          if (!live) return 'no output';
          if (live.querySelector('[role="alert"]')) return 'error';
          if (live.querySelector('[data-change]')) return 'done';
          if (live.querySelector('.animate-spin')) return 'loading';
          return 'idle';
        })()`);
        if (state === "done" || state === "error") return state as string;
        if (Date.now() > deadline) {
          const visible = await pageText();
          throw new Error(`check never finished. visible: ${visible.slice(0, 600)}`);
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    };

    /** Waits for any run in flight to render its paragraphs. */
    const waitForOutput = async () => {
      const deadline = Date.now() + 30000;
      for (;;) {
        const ready = await evaluate(
          `Boolean(document.querySelector('[data-change]')) && !document.querySelector('.animate-spin')`,
        );
        if (ready === true) return;
        if (Date.now() > deadline) return;
        await new Promise((r) => setTimeout(r, 200));
      }
    };

    /**
     * The per-paragraph cards the side-by-side view is built from.
     *
     * `textContent` is read rather than `innerText`: the card is off-screen when
     * it is read, and `innerText` resolves to what is laid out, so it drops the
     * columns that are scrolled out of view.
     */
    const cards = async () =>
      (await evaluate(
        `[...document.querySelectorAll('[data-change]')].map((n) => ({
          index: Number(n.getAttribute('data-change')),
          unchanged: n.getAttribute('data-unchanged') === 'true',
          kept: n.getAttribute('data-kept') === 'true',
          text: n.textContent,
        }))`,
      )) as Array<{ index: number; unchanged: boolean; kept: boolean; text: string }>;

    /** The keep control on one paragraph card, by its index. */
    const toggleFor = (index: number) =>
      evaluate(`(() => {
        const card = document.querySelector('[data-change="${index}"]');
        const b = card ? [...card.querySelectorAll('button')][0] : null;
        if (!b) return null;
        b.click();
        return b.getAttribute('aria-pressed');
      })()`);

    const setViewport = async (width: number, height: number, mobile: boolean) => {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile,
      });
    };

    const screenshot = async (name: string) => {
      const shot = await send("Page.captureScreenshot", { format: "png" });
      const raw = shot.result?.data;
      if (typeof raw !== "string" || raw.length === 0) {
        throw new Error(
          `screenshot returned no data: ${JSON.stringify(shot.result).slice(0, 200)}`,
        );
      }
      const path = join(process.cwd(), "scripts", name);
      await Bun.write(path, Buffer.from(raw, "base64"));
      console.log(`  shot ${name} (${Math.round(raw.length / 1365)}kb)`);
    };

    /** What the provider actually received on its last run. */
    const lastProviderCall = async () => {
      const body = (await (await fetch(`${MOCK}/__mock/last`)).json()) as {
        last: { model: string | null; temperature: number | null; bearer: string } | null;
      };
      return body.last;
    };

    // ---------------------------------------------------------------- desktop
    console.log("\ndesktop 1280x900");
    await setViewport(1280, 900, false);
    await gotoAsync(BASE);
    await waitForReact();

    // The key and model sit above the two-column draft area, so the control
    // card is framed on its own. The sticky header would cover the model row
    // otherwise.
    await evaluate(
      `(() => {
        const draft = document.getElementById('draft');
        const stack = draft ? draft.closest('.space-y-6') : null;
        const controls = stack ? stack.firstElementChild : null;
        if (!controls) return 'not found';
        controls.scrollIntoView({ block: 'start' });
        return 'scrolled';
      })()`,
    );
    await new Promise((r) => setTimeout(r, 500));

    // The picker fills in from a fetch on mount, so wait for the real chips.
    const health = (await (await fetch(`${BASE}/api/health`)).json()) as {
      llm: {
        configured: boolean;
        models: Array<{ id: string; label: string; note: string }>;
        defaultModel: string | null;
      };
    };
    const expectedLabels = health.llm.models.map((model) => model.label);

    const modelButtons = async () =>
      (await evaluate(
        `[...document.querySelectorAll('button')]
          .map((b) => b.textContent.trim())
          .filter((t) => ${JSON.stringify(expectedLabels)}.includes(t))`,
      )) as string[];

    const waitForModels = async () => {
      const deadline = Date.now() + 15000;
      for (;;) {
        const found = await modelButtons();
        if (found.length === expectedLabels.length && expectedLabels.length > 0) return found;
        if (Date.now() > deadline) {
          throw new Error(
            `model row never filled in. expected ${expectedLabels.length}, found ${found.length}`,
          );
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    };

    // ------------------------------------------------------- key and model row
    console.log("\napi key and model row");
    const controlsText = await pageText();
    check("the key field is labelled", controlsText.includes("API key"), controlsText.slice(0, 200));
    check(
      "the key field says where the key is kept",
      controlsText.includes("saved in this browser only"),
      controlsText.slice(0, 200),
    );
    check(
      "the key input is masked by default",
      (await evaluate(`document.getElementById('api-key').getAttribute('type')`)) === "password",
    );

    await clickByText("button", "Show");
    await new Promise((r) => setTimeout(r, 200));
    check(
      "the reveal control unmasks the key",
      (await evaluate(`document.getElementById('api-key').getAttribute('type')`)) === "text",
    );
    await clickByText("button", "Hide");
    await new Promise((r) => setTimeout(r, 200));
    check(
      "the reveal control masks the key again",
      (await evaluate(`document.getElementById('api-key').getAttribute('type')`)) === "password",
    );

    // Typing a key is the whole setup, so it has to persist without a save
    // button and survive a reload.
    const typed = await setValue("#api-key", PASTED_KEY);
    check("a key can be typed in", typed === PASTED_KEY.length, `len=${typed}`);
    await new Promise((r) => setTimeout(r, 200));
    check(
      "the key is saved in this browser",
      (await evaluate(`window.localStorage.getItem('proselens:apiKey')`)) === PASTED_KEY,
    );
    check(
      "a clear control appears once a key is present",
      (await evaluate(
        `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Clear')`,
      )) === true,
    );

    const models = await waitForModels();
    // The label carries a CSS text-transform, which `innerText` resolves to
    // uppercase, so it is matched on the text node rather than the rendered
    // casing.
    check(
      "the model row is labelled",
      (await evaluate(
        `[...document.querySelectorAll('span')].some((n) =>
          getComputedStyle(n).textTransform === 'uppercase' &&
          n.textContent.trim() === 'Model')`,
      )) === true,
    );
    check(
      "the model row offers every model the provider can serve",
      models.length === expectedLabels.length,
      `expected ${expectedLabels.length}, found ${models.length}: ${models.join(", ")}`,
    );

    // The cheapest model leads the list, because it is the one a reader trying
    // the app for the first time should be pointed at.
    check(
      "the cheapest model is offered first",
      health.llm.models[0]?.id === "gpt-5-nano",
      `first=${health.llm.models[0]?.id}`,
    );

    const pressed = (label: string) =>
      evaluate(`(() => {
        const b = [...document.querySelectorAll('button')]
          .find((n) => n.textContent.trim() === ${JSON.stringify(label)});
        return b ? b.getAttribute('aria-pressed') : null;
      })()`);

    check(
      "the default model is preselected",
      (await pressed(expectedLabels[0])) === "true",
      `pressed=${await pressed(expectedLabels[0])}`,
    );

    // The chip carries the price, which is how a reader judges the choice. The
    // title is read from the element because the price is not rendered text.
    const cheapestNote = await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')]
        .find((n) => n.textContent.trim() === ${JSON.stringify(expectedLabels[0])});
      return b ? b.getAttribute('title') : null;
    })()`);
    check(
      "the cheapest model explains what it costs",
      typeof cheapestNote === "string" && cheapestNote.includes("0.05"),
      String(cheapestNote),
    );
    check(
      "the price is shown on the page, not only in a tooltip",
      (await pageText()).includes("0.05"),
      (await pageText()).match(/\\$[0-9.]+ in/)?.[0] ?? "no price",
    );

    // Choosing another model must move the pressed state, which is what the
    // request body is built from.
    const other = expectedLabels[expectedLabels.length - 1];
    await clickByText("button", other);
    await new Promise((r) => setTimeout(r, 200));
    check("choosing another model marks it as the current one", (await pressed(other)) === "true");
    check("the previously selected model is released", (await pressed(expectedLabels[0])) === "false");

    await screenshot("ui-desktop-controls.png");

    // ------------------------------------------------------------ run a chapter
    console.log("\nrun with a pasted key");
    // The cheapest model, chosen deliberately, to prove both the picker and
    // the transport agree: the reasoning models must not receive a temperature.
    await clickByText("button", expectedLabels[0]);
    await new Promise((r) => setTimeout(r, 200));
    check("the cheapest model can be chosen", (await pressed(expectedLabels[0])) === "true");

    await type(PASSAGE);
    await new Promise((r) => setTimeout(r, 200));
    // The count sits under the button, so it is read off the element. innerText
    // is the page's own rendered text and would work, but the count is the one
    // number on the page that can be checked against the source directly.
    const shownWords = Number(
      (await pageText()).match(/(\d+)\s+words? pasted/)?.[1] ?? "0",
    );
    check(
      "the word count follows the paste",
      shownWords === PASSAGE.split(/\s+/).length,
      `shown=${shownWords} expected=${PASSAGE.split(/\s+/).length}`,
    );

    await runCheck();
    await evaluate(
      `document.querySelector('section[aria-live]').scrollIntoView({ block: 'start' })`,
    );
    await new Promise((r) => setTimeout(r, 400));

    const afterRun = await pageText();
    // The provider rewrites the pasted errors rather than the whole sentence, so
    // the rewrite is asserted on the specific words it changed.
    check(
      "the improved chapter is rendered",
      afterRun.includes("she had received the letter"),
      afterRun.slice(-300),
    );
    check(
      "the improved chapter is not the pasted text",
      afterRun.includes("It was a quiet morning and she had received the letter"),
      afterRun.slice(-300),
    );
    check(
      "the pasted text is still shown as the original",
      afterRun.includes("It were a quiet morning"),
      afterRun.slice(-300),
    );
    check(
      "the pasted text is left as written",
      (await evaluate(`document.getElementById('draft').value`)) === PASSAGE,
    );
    check(
      "copy and download are offered once there is output",
      ["Copy", "Download"].every((label) => afterRun.includes(label)),
      afterRun.slice(-300),
    );
    check(
      "no fallback notice is shown on a clean run",
      !afterRun.toLowerCase().includes("falling back"),
      afterRun.slice(-300),
    );

    // ------------------------------------------------------- the side-by-side view
    console.log("\nside-by-side view");

    const rows = await cards();
    check("one card per pasted paragraph", rows.length === 1, `cards=${rows.length}`);
    check(
      "the card holds the reader's own words beside the rewrite",
      rows[0]?.text.includes("It were a quiet morning and she had recieved the letter that morning.") &&
        rows[0]?.text.includes("It was a quiet morning and she had received the letter that morning."),
      rows[0]?.text,
    );
    check(
      "both columns are labelled",
      rows[0]?.text.includes("Original") && rows[0]?.text.includes("Rewritten"),
      rows[0]?.text,
    );
    check(
      "a rewritten paragraph starts kept",
      rows[0]?.kept === true && rows[0]?.unchanged === false,
      JSON.stringify(rows[0]),
    );
    check(
      "the count says what changed",
      (await pageText()).includes("1 of 1 paragraphs rewritten"),
      (await pageText()).match(/\d+ of \d+ paragraphs rewritten/)?.[0] ?? "no count",
    );
    check(
      "the analyst's findings sit under the change they explain",
      rows[0]?.text.includes("Fix the verb form"),
      rows[0]?.text,
    );

    // Undoing a paragraph has to change what Copy and Download export, which
    // is the whole reason the control exists.
    //
    // The clipboard is replaced with a recorder that hands back a promise, so
    // the click can be driven from outside and the captured text read after the
    // handler has settled. Reading it synchronously would race the handler.
    const exported = async () => {
      await evaluate(`(() => {
        window.__copied = null;
        if (!window.__realClipboard) {
          window.__realClipboard = navigator.clipboard.writeText.bind(navigator.clipboard);
        }
        navigator.clipboard.writeText = (t) => { window.__copied = t; return Promise.resolve(); };
        const b = [...document.querySelectorAll('button')]
          .find((n) => n.textContent.trim() === 'Copy' || n.textContent.trim() === 'Copied');
        if (b) b.click();
      })()`);
      for (let i = 0; i < 40; i += 1) {
        const value = await evaluate(`window.__copied`);
        if (typeof value === "string") return value;
        await new Promise((r) => setTimeout(r, 100));
      }
      return null;
    };

    const keptExport = await exported();
    check(
      "Copy exports the rewrite while the change is kept",
      keptExport === "It was a quiet morning and she had received the letter that morning.",
      String(keptExport),
    );

    await toggleFor(0);
    await new Promise((r) => setTimeout(r, 200));
    check(
      "undoing a paragraph flips its control",
      (await evaluate(`document.querySelector('[data-change="0"]').getAttribute('data-kept')`)) === "false",
    );
    check(
      "an undone paragraph reads as undone",
      (await cards())[0]?.text.includes("Undone"),
      (await cards())[0]?.text,
    );
    check(
      "the findings for an undone paragraph are withdrawn with it",
      !(await cards())[0]?.text.includes("Fix the verb form"),
      (await cards())[0]?.text,
    );

    const undoneExport = await exported();
    check(
      "Copy exports the reader's own wording once the change is undone",
      undoneExport === PASSAGE,
      String(undoneExport),
    );

    await clickByText("button", "Keep all");
    await new Promise((r) => setTimeout(r, 200));
    check(
      "Keep all takes every change back",
      (await cards()).every((row) => row.kept === true),
      JSON.stringify((await cards()).map((row) => row.kept)),
    );

    await clickByText("button", "Undo all");
    await new Promise((r) => setTimeout(r, 200));
    check(
      "Undo all reverses every change",
      (await cards()).every((row) => !row.kept),
      JSON.stringify((await cards()).map((row) => row.kept)),
    );
    check(
      "a fully undone chapter exports exactly what was pasted",
      (await exported()) === PASSAGE,
      String(await exported()),
    );
    await clickByText("button", "Keep all");
    await new Promise((r) => setTimeout(r, 200));

    // --------------------------------------------------------- fallback notice
    console.log("\nfallback notice");
    // A provider that answers with prose leaves the reader a corrected chapter
    // and an honest label, with a way to try the model again.
    await fetch(`${MOCK}/__mock/mode?mode=garbage`);
    await runCheck();
    await new Promise((r) => setTimeout(r, 300));
    await waitForOutput();
    const degraded = await pageText();
    check(
      "a failed run still shows a corrected chapter",
      (await cards()).length === 1,
      `cards=${(await cards()).length}`,
    );
    check(
      "a failed run says the rules engine answered",
      degraded.includes("the local rules engine"),
      degraded.slice(-300),
    );
    check(
      "a failed run explains what went wrong",
      String(await evaluate(`document.querySelector('[data-testid="fallback-notice"]')?.innerText ?? ""`)).length > 20,
    );
    check(
      "a failed run offers to try the model again",
      degraded.includes("Try the model again"),
      degraded.slice(-300),
    );

    // The retry makes a fresh run, which is two provider requests. The provider
    // is put back first: the retry is about the app recovering once the provider
    // does, and leaving the mock failing would only prove it fails twice.
    // Waiting on a fixed pause would read the page mid-run and assert against
    // the failure being retried, so the run is waited out like any other.
    await fetch(`${MOCK}/__mock/mode?mode=ok`);
    await clickByText("button", "Try the model again");
    await new Promise((r) => setTimeout(r, 500));
    await waitForOutput();
    check(
      "retrying after a failure reaches the provider once it recovers",
      (await pageText()).includes("she had received the letter"),
      (await pageText()).slice(-300),
    );
    check(
      "the fallback notice clears on a clean run",
      (await evaluate(`document.querySelector('[data-testid="fallback-notice"]') !== null`)) === false,
    );

    const sent = await lastProviderCall();
    check("the provider was called", sent !== null);
    check(
      "the key typed into the page is the one the provider received",
      sent?.bearer === PASTED_KEY,
      `bearer=${sent?.bearer}`,
    );
    check(
      "the model chosen in the picker is the one that ran",
      sent?.model === "gpt-5-nano",
      `model=${sent?.model}`,
    );
    check(
      "the cheapest model is sent without a temperature it would reject",
      sent?.temperature === null,
      `temperature=${String(sent?.temperature)}`,
    );

    // A model that does take a temperature must still get one, or the rewrite
    // is not held stable between runs.
    const temperatureLabel = health.llm.models.find((m) => m.id === "gpt-4o-mini")?.label;
    check("the provider offers a model that takes a temperature", temperatureLabel !== undefined);
    await clickByText("button", temperatureLabel!);
    await new Promise((r) => setTimeout(r, 200));
    check(
      "the clicked model chip is the active one",
      (await evaluate(
        `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(temperatureLabel)})?.getAttribute('aria-pressed')`,
      )) === "true",
    );
    await runCheck();
    await waitForOutput();
    const sentSecond = await lastProviderCall();
    check(
      "a model that takes a temperature is sent one",
      sentSecond?.model === "gpt-4o-mini" && typeof sentSecond?.temperature === "number",
      `model=${sentSecond?.model} temperature=${String(sentSecond?.temperature)}`,
    );

    await screenshot("ui-desktop-output.png");

    // ------------------------------------------------------- key survives reload
    console.log("\nkey persistence across a reload");
    await gotoAsync(BASE);
    await waitForReact();
    await new Promise((r) => setTimeout(r, 600));
    check(
      "the saved key is still in the field after a reload",
      (await evaluate(`document.getElementById('api-key').value`)) === PASTED_KEY,
      String(await evaluate(`document.getElementById('api-key').value`)),
    );
    check(
      "the key stays masked after a reload",
      (await evaluate(`document.getElementById('api-key').getAttribute('type')`)) === "password",
    );

    // ----------------------------------------------------------------- mobile
    console.log("\nmobile 390x844");
    await setViewport(390, 844, true);
    await gotoAsync(BASE);
    await waitForReact();
    await new Promise((r) => setTimeout(r, 600));

    const mobileOverflow = await evaluate(
      "document.documentElement.scrollWidth - document.documentElement.clientWidth",
    );
    check("no horizontal overflow on mobile", Number(mobileOverflow) <= 1, `overflow ${mobileOverflow}px`);

    // The key row holds an input plus two chips, which is the tightest row on
    // the page at 390px.
    const keyRow = await evaluate(`(() => {
      const input = document.getElementById('api-key');
      if (!input) return null;
      const r = input.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    })()`) as { w: number; h: number } | null;
    check(
      "the key field stays usable on mobile",
      keyRow !== null && keyRow.w >= 140 && keyRow.h >= 24,
      JSON.stringify(keyRow),
    );

    // WCAG 2.2 AA (2.5.8) sets the floor at 24x24 CSS pixels. The model chips
    // share the app's `.chip` styling, so the check holds every one of them to
    // that same floor.
    const mobileModel = (await evaluate(
      `[...document.querySelectorAll('button')]
        .map((b) => {
          const r = b.getBoundingClientRect();
          return { text: b.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height) };
        })
        .filter((b) => ${JSON.stringify(expectedLabels)}.includes(b.text))`,
    )) as Array<{ text: string; w: number; h: number }>;
    check(
      "every model chip stays tappable on mobile",
      mobileModel.length === expectedLabels.length && mobileModel.every((chip) => chip.h >= 24),
      JSON.stringify(mobileModel.filter((c) => c.h < 24)),
    );

    // The chips wrap onto several lines at 390px, so they have to stay inside
    // the viewport rather than run off the right edge.
    const widestChip = mobileModel.reduce((max, chip) => Math.max(max, chip.w), 0);
    check("the model chips fit the phone width", widestChip <= 390, `widest ${widestChip}px`);

    // A full run on a phone, because the output scrolls into view there and
    // that is the part a phone reader actually sees.
    await type(PASSAGE);
    await new Promise((r) => setTimeout(r, 200));
    await runCheck();
    await waitForOutput();
    const mobileAfter = await pageText();
    check("the improved chapter renders on mobile", mobileAfter.includes("she had received the letter"));
    check(
      "the side-by-side view renders on mobile",
      (await cards()).length === 1,
      `cards=${(await cards()).length}`,
    );

    const mobileRunOverflow = await evaluate(
      "document.documentElement.scrollWidth - document.documentElement.clientWidth",
    );
    check(
      "no horizontal overflow once a result is showing",
      Number(mobileRunOverflow) <= 1,
      `overflow ${mobileRunOverflow}px`,
    );
    await screenshot("ui-mobile-output.png");

    // --------------------------------------------------------- error and empty
    console.log("\nedge states");
    await setViewport(1280, 900, false);
    await gotoAsync(BASE);
    await waitForReact();
    await new Promise((r) => setTimeout(r, 400));

    const idle = await pageText();
    check("the empty state explains where the output goes", idle.includes("will appear here"));

    await type("   ");
    await new Promise((r) => setTimeout(r, 200));
    check(
      "the run button is disabled with no text",
      (await evaluate(
        `[...document.querySelectorAll('button')]
          .find((b) => b.textContent.trim() === 'Improve this chapter')?.disabled ?? null`,
      )) === true,
    );

    // Clearing the key has to be able to reach the empty state again, and it
    // has to leave nothing behind in storage.
    await clickByText("button", "Clear");
    await new Promise((r) => setTimeout(r, 300));
    check(
      "clearing the key empties the field",
      (await evaluate(`document.getElementById('api-key').value`)) === "",
    );
    check(
      "clearing the key removes it from storage",
      (await evaluate(`window.localStorage.getItem('proselens:apiKey')`)) === null,
      String(await evaluate(`window.localStorage.getItem('proselens:apiKey')`)),
    );

    await gotoAsync(`${BASE}/definitely-not-a-real-route`);
    check("the 404 page still offers a way back", (await pageText()).includes("Back to the editor"));

    console.log("\nconsole");
    check(
      "no uncaught page exceptions",
      pageErrors.length === 0,
      pageErrors.join(" | ").slice(0, 400),
    );
    check(
      "no console errors",
      consoleErrors.length === 0,
      consoleErrors.join(" | ").slice(0, 400),
    );

    socket.close();
  } finally {
    cleanup();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (problems.length) console.log(`failing: ${problems.join(", ")}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
