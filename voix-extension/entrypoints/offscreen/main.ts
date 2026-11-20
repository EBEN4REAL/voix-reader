// Offscreen document: fetches sentence audio from the voice service and plays
// it. Running here (an extension page) avoids page CSP and CORS limits and
// lets playbackRate change speed with preservesPitch.

import type { EngineEvent, EngineEventMessage, ToOffscreen } from "../../src/controller/engine";
import { recognize } from "../../src/docs/ocr";
import { runPdfJob } from "../../src/docs/pdfReader";
import { DocError, type DocEvent, type DocJob } from "../../src/docs/protocol";
import { cleanOcrText } from "../../src/docs/text";

const CACHE_LIMIT = 40;
const REQUEST_TIMEOUT_MS = 15_000; // then offer the device voice
const MAX_RETRY_WAIT_MS = 30_000;

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

/** A failed speech request; code is the voice service's error code (see server.py /v1/speak). */
class SpeakFailure extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

interface SpeechVoice {
  voiceId: string;
  lang: string;
  engine?: string;
  /** How the language was chosen; logged by the server. */
  source?: string;
}

async function requestSpeech(text: string, { voiceId, lang, engine, source }: SpeechVoice, server: { url: string; apiKey: string }) {
  const url = `${server.url.replace(/\/+$/, "")}/v1/speak`;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(server.apiKey ? { Authorization: `Bearer ${server.apiKey}` } : {}) },
        // Generated at 1.0x; speed is applied with playbackRate.
        body: JSON.stringify({ text, voice: voiceId, lang, engine, response_format: "mp3", source }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      const timedOut = (e as Error)?.name === "TimeoutError";
      throw new SpeakFailure(timedOut ? "The voice service took too long to answer" : "Voice service unavailable", "engine_unavailable");
    }
    if (res.ok) return res.blob();
    const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string; detail?: string };
    if (res.status === 429 && attempt === 0) {
      // Rate limited: wait as long as the service asks (within reason), then try once more.
      const wait = Number(res.headers.get("Retry-After")) * 1000;
      await new Promise((r) => setTimeout(r, Math.min(Number.isFinite(wait) && wait > 0 ? wait : 2000, MAX_RETRY_WAIT_MS)));
      continue;
    }
    throw new SpeakFailure(body.message ?? body.detail ?? `Voice service error (HTTP ${res.status})`,
      body.code ?? (res.status >= 500 ? "engine_unavailable" : undefined));
  }
}

function fetchAudio(text: string, voice: SpeechVoice, server: { url: string; apiKey: string }): Promise<string> {
  // Language is part of the key: the same text read under two languages is different audio.
  const key = `${server.url}|${voice.lang}|${voice.voiceId}|${text}`;
  let entry = cache.get(key);
  if (!entry) {
    entry = requestSpeech(text, voice, server).then((blob) => URL.createObjectURL(blob));
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
    const voice: SpeechVoice = { voiceId: c.voiceId, lang: c.lang, engine: c.engine, source: c.langSource };
    fetchAudio(c.text, voice, server)
      .then(async (url) => {
        if (!isCurrent()) return; // superseded
        for (const t of c.prefetch) fetchAudio(t, voice, server).catch(() => {});
        audio.src = url;
        audio.playbackRate = c.rate;
        audio.preservesPitch = true;
        if (!paused) await audio.play();
      })
      .catch((e: Error) => {
        if (!isCurrent()) return;
        const code = e instanceof SpeakFailure ? e.code : undefined;
        emit({ type: "error", requestId, message: e.message || "Voice service unavailable", code });
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
