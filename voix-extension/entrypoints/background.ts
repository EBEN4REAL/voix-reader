import type {
  EngineCommand, EngineEventMessage, FrameExtract, FrameRequest, ToBackground, ToOffscreen,
} from "../src/controller/engine";
import type { DocJob, DocRequest } from "../src/docs/protocol";
import { loadPrefs } from "../src/storage";

// Routes messages between the page widgets (content scripts), the single
// offscreen document (audio, PDF extraction, OCR) and sub-frames.

export default defineBackground(() => {
  browser.action.onClicked.addListener((tab) => {
    if (tab.id != null) void toggleWidget(tab.id);
  });

  browser.commands.onCommand.addListener((command, tab) => {
    if (command === "toggle-voix" && tab?.id != null) void toggleWidget(tab.id);
  });

  browser.runtime.onMessage.addListener((msg: ToBackground | EngineEventMessage, sender, sendResponse) => {
    if (msg?.target === "tab") {
      const payload = msg.event
        ? { type: "voix:engine-event", event: msg.event }
        : { type: "voix:doc-event", event: msg.docEvent };
      browser.tabs.sendMessage(msg.tabId, payload).catch(() => {});
      return;
    }
    if (msg?.target !== "background") return;
    const tab = sender.tab;

    if (msg.action === "open-options") void openOptions(msg.hash);
    if (msg.command && tab?.id != null) void forwardCommand(tab.id, msg.command);
    const reply = (p: Promise<unknown>) => {
      p.then(sendResponse, (e: Error) => sendResponse({ ok: false, error: e?.message }));
      return true; // keep the channel open for the async response
    };
    if (msg.doc && tab?.id != null) return reply(handleDoc(tab.id, tab.windowId, msg.doc));
    if (msg.frames && tab?.id != null) return reply(handleFrames(tab.id, msg.frames));
    if (msg.fetchText) return reply(fetchText(msg.fetchText));
  });

  // Don't keep reading for a tab that is gone.
  browser.tabs.onRemoved.addListener((tabId) => {
    void browser.offscreen.hasDocument().then((has) => {
      if (has) void forwardCommand(tabId, { type: "stop" });
    });
  });
});

async function toggleWidget(tabId: number) {
  try {
    await browser.tabs.sendMessage(tabId, { type: "voix:toggle" });
  } catch {
    // Tab was open before the extension was installed/reloaded: inject, then retry.
    try {
      await browser.scripting.executeScript({ target: { tabId }, files: ["/content-scripts/content.js"] });
      await browser.tabs.sendMessage(tabId, { type: "voix:toggle" });
    } catch {
      // chrome:// pages and the Web Store can't be scripted. Local files need the
      // "Allow access to file URLs" switch: explain how to turn it on.
      if (!(await browser.extension.isAllowedFileSchemeAccess())) {
        const tab = await browser.tabs.get(tabId).catch(() => null);
        if (!tab?.url || tab.url.startsWith("file:")) void openOptions("file-access");
      }
    }
  }
}

function openOptions(hash?: string) {
  if (!hash) return browser.runtime.openOptionsPage();
  return browser.tabs.create({ url: browser.runtime.getURL(`/options.html#${hash}` as "/options.html") });
}

// ---------- offscreen document ----------

let creating: Promise<void> | null = null;

async function ensureOffscreen() {
  if (await browser.offscreen.hasDocument()) return;
  creating ??= browser.offscreen
    .createDocument({
      url: browser.runtime.getURL("/offscreen.html"),
      reasons: ["AUDIO_PLAYBACK", "WORKERS", "BLOBS"],
      justification: "Play article audio, and extract text from PDFs and images (PDF.js and OCR workers)",
    })
    .finally(() => (creating = null));
  await creating;
}

async function forwardCommand(tabId: number, command: EngineCommand) {
  const [{ serverUrl, apiKey }] = await Promise.all([loadPrefs(["serverUrl", "apiKey"]), ensureOffscreen()]);
  const msg: ToOffscreen = { target: "offscreen", tabId, command, server: { url: serverUrl, apiKey } };
  await browser.runtime.sendMessage(msg).catch(() => {});
}

async function forwardJob(tabId: number, job: DocJob) {
  await ensureOffscreen();
  const msg: ToOffscreen = { target: "offscreen", tabId, job };
  await browser.runtime.sendMessage(msg).catch(() => {});
}

async function handleDoc(tabId: number, windowId: number, req: DocRequest) {
  if (req.kind === "ocr-screen") {
    const dataUrl = await browser.tabs.captureVisibleTab(windowId, { format: "png" });
    void forwardJob(tabId, { kind: "ocr-image", jobId: req.jobId, dataUrl });
  } else {
    await forwardJob(tabId, req);
  }
  return { ok: true };
}

// ---------- sub-frames (documents inside iframes, e.g. Word for the web) ----------
// The frame content script exposes window.__voixFrame in the extension's isolated
// world; executeScript runs in that same world, so it can call it directly.

interface FrameApi {
  extract(mode: "article" | "page"): { texts: string[]; chars: number } | null;
  highlight(index: number, highlight: boolean, scroll: boolean): void;
  clear(): void;
}

async function handleFrames(tabId: number, req: FrameRequest): Promise<FrameExtract | null> {
  if (req.op === "extract") {
    const results = await browser.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (mode: "article" | "page") =>
        (globalThis as unknown as { __voixFrame?: FrameApi }).__voixFrame?.extract(mode) ?? null,
      args: [req.mode],
    });
    let best: FrameExtract | null = null;
    for (const r of results) {
      const res = r.result as { texts: string[]; chars: number } | null;
      if (r.frameId === 0 || !res) continue;
      if (!best || res.chars > best.chars) best = { frameId: r.frameId, ...res };
    }
    return best;
  }
  const target = { tabId, frameIds: [req.frameId] };
  if (req.op === "highlight") {
    await browser.scripting.executeScript({
      target,
      func: (i: number, h: boolean, s: boolean) =>
        (globalThis as unknown as { __voixFrame?: FrameApi }).__voixFrame?.highlight(i, h, s),
      args: [req.index, req.highlight, req.scroll],
    }).catch(() => {});
  } else {
    await browser.scripting.executeScript({
      target,
      func: () => (globalThis as unknown as { __voixFrame?: FrameApi }).__voixFrame?.clear(),
    }).catch(() => {});
  }
  return null;
}

// ---------- cross-origin text (e.g. Google Docs export redirects) ----------

async function fetchText(url: string) {
  const res = await fetch(url, { credentials: "include" });
  const type = res.headers.get("content-type") ?? "";
  return { ok: res.ok && !type.includes("text/html"), status: res.status, text: res.ok ? await res.text() : "" };
}
