// Offscreen document: fetches sentence audio from the voice service and plays
// it. Running here (an extension page) avoids page CSP and CORS limits and
// lets playbackRate change speed with preservesPitch.

import type { EngineEvent, EngineEventMessage, ToOffscreen } from "../../src/controller/engine";
import { recognize } from "../../src/docs/ocr";
import { runPdfJob } from "../../src/docs/pdfReader";
import { DocError, type DocEvent, type DocJob } from "../../src/docs/protocol";
import { cleanOcrText } from "../../src/docs/text";

const CACHE_LIMIT = 40;

const audio = new Audio();
audio.preservesPitch = true;

const cache = new Map<string, Promise<string>>(); // key -> blob URL
let tabId = -1;
let current = -1; // requestId being played
let paused = false;

function emit(event: EngineEvent, toTab = tabId) {
  if (toTab < 0) return;
  const msg: EngineEventMessage = { target: "tab", tabId: toTab, event };
  browser.runtime.sendMessage(msg).catch(() => {});
}

audio.addEventListener("playing", () => current >= 0 && emit({ type: "playing", requestId: current }));
audio.addEventListener("ended", () => current >= 0 && emit({ type: "ended", requestId: current }));

// ---------- document jobs (PDF extraction, OCR) ----------

const cancelled = new Set<string>();

function emitDoc(toTab: number, docEvent: DocEvent) {
  const msg: EngineEventMessage = { target: "tab", tabId: toTab, docEvent };
  browser.runtime.sendMessage(msg).catch(() => {});
}

async function runJob(toTab: number, job: DocJob) {
  if (job.kind === "cancel") {
    cancelled.add(job.jobId);
    return;
  }
  const emit = (e: DocEvent) => emitDoc(toTab, e);
  const isCancelled = () => cancelled.has(job.jobId);
  try {
    if (job.kind === "pdf") {
      await runPdfJob(job, emit, isCancelled);
    } else {
      emit({ jobId: job.jobId, type: "progress", message: "Reading the text on screen…" });
      const paragraphs = cleanOcrText(await recognize(job.dataUrl));
      if (!isCancelled()) {
        emit({ jobId: job.jobId, type: "paragraphs", page: 1, pages: 1, paragraphs });
        emit({ jobId: job.jobId, type: "done", pages: 1 });
      }
    }
  } catch (e) {
    const err = e instanceof DocError ? e : new DocError("unknown", (e as Error)?.message || "Something went wrong.");
    if (!isCancelled()) emit({ jobId: job.jobId, type: "error", code: err.code, message: err.message });
  } finally {
    cancelled.delete(job.jobId);
  }
}

// ---------- audio ----------

function fetchAudio(text: string, voiceId: string, server: { url: string; apiKey: string }): Promise<string> {
  const { url: serverUrl, apiKey } = server;
  const key = `${serverUrl}|${voiceId}|${text}`;
  let entry = cache.get(key);
  if (!entry) {
    entry = fetch(`${serverUrl.replace(/\/+$/, "")}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      // Generated at 1.0x; speed is applied with playbackRate.
      body: JSON.stringify({ input: text, voice: voiceId, response_format: "mp3" }),
    }).then(async (res) => {
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))) as { detail?: string };
        throw new Error(detail.detail ?? `Voice service error (HTTP ${res.status})`);
      }
      return URL.createObjectURL(await res.blob());
    });
    entry.catch(() => cache.delete(key));
    cache.set(key, entry);
    while (cache.size > CACHE_LIMIT) {
      const [oldKey, old] = cache.entries().next().value as [string, Promise<string>];
      cache.delete(oldKey);
      old.then(URL.revokeObjectURL, () => {});
    }
  }
  return entry;
}

browser.runtime.onMessage.addListener((msg: ToOffscreen) => {
  if (msg?.target !== "offscreen") return;
  if ("job" in msg) {
    void runJob(msg.tabId, msg.job);
    return;
  }
  const c = msg.command;
  const server = msg.server;

  if (c.type === "play") {
    if (tabId >= 0 && tabId !== msg.tabId && current >= 0) emit({ type: "interrupted" }, tabId);
    tabId = msg.tabId;
    current = c.requestId;
    paused = false;
    audio.pause();
    const requestId = c.requestId;
    const owner = msg.tabId;
    // requestIds are per tab, so "still current" means same tab and same id.
    const isCurrent = () => requestId === current && owner === tabId;
    fetchAudio(c.text, c.voiceId, server)
      .then(async (url) => {
        if (!isCurrent()) return; // superseded
        for (const t of c.prefetch) fetchAudio(t, c.voiceId, server).catch(() => {});
        audio.src = url;
        audio.playbackRate = c.rate;
        audio.preservesPitch = true;
        if (!paused) await audio.play();
      })
      .catch((e: Error) => {
        if (isCurrent()) emit({ type: "error", requestId, message: e.message || "Voice service unavailable" });
      });
    return;
  }

  if (c.type === "resume" && (msg.tabId !== tabId || !audio.src)) {
    // Nothing to resume: this document was recreated, or never had this tab's audio.
    emit({ type: "lost" }, msg.tabId);
    return;
  }
  if (msg.tabId !== tabId) return; // commands from a tab that no longer owns playback

  switch (c.type) {
    case "pause":
      paused = true;
      audio.pause();
      break;
    case "resume":
      paused = false;
      if (audio.src) audio.play().catch(() => {});
      break;
    case "stop":
      current = -1;
      paused = false;
      audio.pause();
      audio.removeAttribute("src");
      break;
    case "rate":
      audio.playbackRate = c.rate;
      break;
  }
});
