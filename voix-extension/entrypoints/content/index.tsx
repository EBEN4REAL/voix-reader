import ReactDOM from "react-dom/client";
import { DocJobs, DomSession, FrameSession, TEXT_ONLY, type Session } from "../../src/content/sessions";
import { ExtensionAudioEngine, SpeechSynthesisEngine, type FrameExtract, type ToBackground } from "../../src/controller/engine";
import { VoixReaderController } from "../../src/controller/reader";
import type { ReaderState } from "../../src/controller/types";
import { bytesToBase64, type DocEvent } from "../../src/docs/protocol";
import {
  estimateMinutes, googleExportUrl, plainTextParagraphs, sheetParagraphs, splitSentences, type GoogleKind,
} from "../../src/docs/text";
import {
  findEmbeddedPdf, hasLargeCanvas, isPdfDocument, isPlainTextDocument, PageText,
} from "../../src/page/extract";
import { clearHighlight } from "../../src/page/highlight";
import { isSensitiveHost } from "../../src/page/sensitive";
import { loadPrefs, savePrefs } from "../../src/storage";
import { loadVoixFont } from "../../src/ui/font";
import { UiStore, type WidgetActions } from "../../src/ui/uiStore";
import { Widget } from "../../src/ui/Widget";
import "../../src/ui/widget.css";

const PROMPT_MIN_CHARS = 1500; // only offer to read real articles
const PROMPT_DELAY_MS = 1500;
const FRAME_MIN_CHARS = 400; // an iframe with this much text is treated as the document (ads have far less)

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_idle",
  cssInjectionMode: "ui",

  async main(ctx) {
    const page = new PageText();
    const ui = new UiStore();
    const jobs = new DocJobs();
    const controller = new VoixReaderController(
      new ExtensionAudioEngine(),
      SpeechSynthesisEngine.available() ? new SpeechSynthesisEngine() : null,
    );
    void controller.loadPrefs();
    const lang = document.documentElement.lang || undefined;

    let session: Session = TEXT_ONLY;
    let activeJob: string | null = null;
    let generation = 0; // bumps whenever a new reading starts or the widget closes

    // Remember the latest non-empty selection: clicking a widget button may collapse it.
    let lastSelection: Range | null = null;
    const liveSelection = () => {
      const sel = getSelection();
      return sel && !sel.isCollapsed && sel.rangeCount && sel.toString().trim() ? sel.getRangeAt(0) : null;
    };
    document.addEventListener("selectionchange", () => {
      const range = liveSelection();
      if (range) {
        lastSelection = range.cloneRange();
        if (!ui.getState().hasSelection) ui.set({ hasSelection: true });
      }
    });

    // ----- widget mounting (lazy: nothing is added to the page until needed) -----

    let host: HTMLElement | null = null;
    let mounted: Promise<unknown> | null = null;
    const ensureMounted = () =>
      (mounted ??= createShadowRootUi(ctx, {
        name: "voix-widget",
        position: "inline",
        anchor: "body",
        append: "last",
        isolateEvents: true, // keys typed in the widget never reach the page's shortcuts
        onMount(container) {
          const root = ReactDOM.createRoot(container);
          root.render(<Widget controller={controller} ui={ui} actions={actions} />);
          return root;
        },
        onRemove(root) {
          root?.unmount();
        },
      }).then((shadowUi) => {
        shadowUi.mount();
        host = shadowUi.shadowHost;
        void loadVoixFont(browser.runtime.getURL("/fonts/PlusJakartaSans-Variable.woff2"));
      }));

    // ----- sources -----

    const toSentences = (texts: string[], offset = 0) => texts.map((text, i) => ({ id: `s${offset + i}`, text }));

    function begin(next: Session): number {
      if (activeJob) jobs.cancel(activeJob);
      activeJob = null;
      session.clear();
      session = next;
      ui.set({ card: null, mode: "expanded" });
      return ++generation;
    }

    /** Text already in the page (or an iframe): highlightable. */
    function readTexts(texts: string[], next: Session) {
      begin(next);
      controller.load(toSentences(texts));
      controller.play();
    }

    /** Streams sentences from a document job into the reader. */
    function jobHandler(gen: number, emptyMessage: string) {
      let count = 0;
      return (e: DocEvent) => {
        if (gen !== generation) return;
        if (e.type === "progress") controller.setLoadingMessage(e.message);
        else if (e.type === "paragraphs") {
          const sentences = splitSentences(e.paragraphs, lang);
          controller.append(toSentences(sentences, count));
          count += sentences.length;
        } else if (e.type === "done") controller.finishLoading(emptyMessage);
        else if (e.type === "error") controller.fail(e.message);
      };
    }

    /** Chrome's PDF viewer is closed to extensions: the widget's list follows along instead of the page. */
    async function readPdf(url: string) {
      const gen = begin(TEXT_ONLY);
      controller.prepare("Opening PDF…");
      const handle = jobHandler(gen, "This PDF has no readable text.");
      let triedBytes = false;
      const onEvent = async (e: DocEvent) => {
        // Files behind a login: the extension's own download can be refused, but the page
        // itself (same origin, with its cookies) can fetch the bytes.
        if (e.type === "error" && e.code === "fetch-failed" && !triedBytes && new URL(url).origin === location.origin) {
          triedBytes = true;
          try {
            const bytes = new Uint8Array(await (await fetch(url, { credentials: "include" })).arrayBuffer());
            activeJob = jobs.newId();
            await jobs.start(activeJob, { kind: "pdf", url, bytesB64: bytesToBase64(bytes), ocr: true }, onEvent);
            return;
          } catch {
            // fall through to the original error
          }
        }
        handle(e);
      };
      activeJob = jobs.newId();
      await jobs.start(activeJob, { kind: "pdf", url, ocr: true }, onEvent).catch((e: Error) => controller.fail(e.message));
    }

    /** OCR of what's visible: canvas-rendered documents, images of text. */
    async function readScreen(message = "Reading the text on screen…") {
      const gen = begin(TEXT_ONLY);
      controller.prepare(message);
      // Keep the widget and highlight out of the screenshot.
      clearHighlight();
      if (host) host.style.visibility = "hidden";
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      activeJob = jobs.newId();
      try {
        await jobs.start(activeJob, { kind: "ocr-screen" }, jobHandler(gen, "No readable text was found on screen."));
      } catch {
        controller.fail("Voix couldn't capture this page to read it.");
      } finally {
        if (host) host.style.visibility = "";
      }
    }

    async function fetchText(url: string): Promise<string> {
      const res = await fetch(url, { credentials: "include" }).catch(() => null);
      if (res?.ok && !(res.headers.get("content-type") ?? "").includes("text/html")) return res.text();
      // Cross-origin redirect (blocked here by CORS): retry with the extension's permissions.
      const msg: ToBackground = { target: "background", fetchText: url };
      const viaBackground = (await browser.runtime.sendMessage(msg).catch(() => null)) as { ok: boolean; text: string } | null;
      if (viaBackground?.ok) return viaBackground.text;
      throw new Error("export failed");
    }

    /** Google Docs/Slides/Sheets draw on a canvas; their text export is the reliable source. */
    async function readGoogle(g: { kind: GoogleKind; url: string }) {
      const gen = begin(TEXT_ONLY);
      controller.prepare("Getting the document text…");
      try {
        const text = await fetchText(g.url);
        const paragraphs = g.kind === "spreadsheets" ? sheetParagraphs(text) : plainTextParagraphs(text);
        const sentences = splitSentences(paragraphs, lang);
        if (!sentences.length) throw new Error("empty");
        if (gen !== generation) return;
        controller.append(toSentences(sentences));
        controller.finishLoading();
      } catch {
        // Downloading disabled by the owner, or not signed in: read what's on screen.
        if (gen === generation) await readScreen("Reading the text on screen…");
      }
    }

    async function bestFrame(minChars: number): Promise<FrameExtract | null> {
      const msg: ToBackground = { target: "background", frames: { op: "extract", mode: "page" } };
      const best = (await browser.runtime.sendMessage(msg).catch(() => null)) as FrameExtract | null;
      return best && best.chars >= minChars ? best : null;
    }

    /** Pick the best source for this page, in order of confidence. */
    async function readBest() {
      const sel = liveSelection();
      const selected = sel && page.extract("selection", sel);
      if (selected) return readTexts(selected, new DomSession(page));
      if (isPdfDocument()) return readPdf(location.href);
      const google = googleExportUrl(location.href);
      if (google) return readGoogle(google);
      if (isPlainTextDocument()) {
        const texts = page.extract("plain");
        if (texts) return readTexts(texts, new DomSession(page));
      }
      const article = page.extract("article");
      if (article) return readTexts(article, new DomSession(page));
      const frame = await bestFrame(FRAME_MIN_CHARS);
      if (frame) return readTexts(frame.texts, new FrameSession(frame.frameId));
      const pdf = findEmbeddedPdf();
      if (pdf) return readPdf(pdf);
      ui.set({ card: { kind: "noArticle" }, mode: "closed" });
    }

    async function readWholePage() {
      const texts = page.extract("page");
      const chars = texts?.join(" ").length ?? 0;
      // A few toolbar labels around a big canvas: the document itself is drawn, not text.
      if (texts && !(chars < 300 && hasLargeCanvas())) return readTexts(texts, new DomSession(page));
      const frame = await bestFrame(1);
      if (frame) return readTexts(frame.texts, new FrameSession(frame.frameId));
      const pdf = findEmbeddedPdf();
      if (pdf) return readPdf(pdf);
      return readScreen();
    }

    // ----- opening and closing -----

    const isOpen = () => ui.getState().mode !== "closed" || ui.getState().card !== null;

    async function open() {
      await ensureMounted();
      if (isSensitiveHost()) return ui.set({ card: { kind: "blocked" } });
      const { privacyAccepted } = await loadPrefs(["privacyAccepted"]);
      if (!privacyAccepted) return ui.set({ card: { kind: "privacy" } });
      await readBest();
    }

    function close() {
      generation++;
      if (activeJob) jobs.cancel(activeJob);
      activeJob = null;
      controller.stop();
      session.clear();
      ui.set({ mode: "closed", card: null });
    }

    const actions: WidgetActions = {
      onListen: () => void open(),
      onNotNow: () => ui.set({ card: null }),
      onNeverOnSite: async () => {
        ui.set({ card: null });
        const { neverSites } = await loadPrefs(["neverSites"]);
        if (!neverSites.includes(location.hostname)) {
          await savePrefs({ neverSites: [...neverSites, location.hostname] });
        }
      },
      onPrivacyAccepted: async () => {
        await savePrefs({ privacyAccepted: true });
        ui.set({ card: null });
        void open();
      },
      onPrivacyDetails: () => {
        browser.runtime.sendMessage({ target: "background", action: "open-options" }).catch(() => {});
      },
      onReadSelection: () => {
        const texts = page.extract("selection", lastSelection);
        if (texts) readTexts(texts, new DomSession(page));
      },
      onReadWholePage: () => void readWholePage(),
      onClose: close,
    };

    // ----- the page follows the reader (highlight, auto-scroll) -----

    let prev: ReaderState | null = null;
    controller.subscribe((s) => {
      const active = s.status !== "idle" && s.status !== "error" && s.sentences.length > 0;
      const indexChanged = s.currentIndex !== prev?.currentIndex || s.sentences[0] !== prev?.sentences[0];
      if (!active) session.clear();
      else if (indexChanged || s.settings !== prev?.settings || prev?.status !== s.status) {
        session.sync(s.currentIndex, s.settings, indexChanged);
      }
      prev = s;
    });

    // ----- messages from the background (toolbar icon, keyboard shortcut) -----

    browser.runtime.onMessage.addListener((msg: { type?: string }) => {
      if (msg?.type === "voix:toggle") {
        if (isOpen()) close();
        else void open();
      }
    });

    window.addEventListener("pagehide", () => close());
    ctx.onInvalidated(() => {
      controller.stop();
      session.clear();
    });

    // ----- auto prompt on articles and PDFs -----

    if (isSensitiveHost()) return;
    const { neverSites } = await loadPrefs(["neverSites"]);
    if (neverSites.includes(location.hostname)) return;

    const showPrompt = async (minutes: number, noun: "article" | "document") => {
      if (isOpen()) return;
      await ensureMounted();
      if (!isOpen()) ui.set({ card: { kind: "prompt", minutes, noun } });
    };

    ctx.setTimeout(() => {
      if (isOpen()) return;
      if (isPdfDocument()) {
        // Estimate listening time from the first pages' text (no OCR: scans just don't prompt).
        const sampled: string[] = [];
        let pages = 1;
        let seen = 0;
        void jobs.start(jobs.newId(), { kind: "pdf", url: location.href, ocr: false, maxPages: 5 }, (e) => {
          if (e.type === "paragraphs") {
            sampled.push(...e.paragraphs);
            pages = e.pages;
            seen = e.page;
          } else if (e.type === "done" && sampled.join(" ").length >= 300) {
            const perPage = sampled.join(" ").split(/\s+/).length / Math.max(1, seen);
            void showPrompt(Math.max(1, Math.round((perPage * pages) / 150)), "document");
          }
        }).catch(() => {});
        return;
      }
      if (googleExportUrl(location.href)) return; // someone editing a doc doesn't need a prompt
      const texts = page.extract("article");
      if (texts && texts.join(" ").length >= PROMPT_MIN_CHARS) void showPrompt(estimateMinutes(texts), "article");
    }, PROMPT_DELAY_MS);
  },
});
