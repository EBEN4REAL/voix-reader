import { browser } from "wxt/browser";
import type { DocEvent, DocJob, DocRequest } from "../docs/protocol";

// Audio engines the real controller drives. The natural-voice engine lives in
// the extension's offscreen document (reached via the background script); the
// fallback engine is the browser's built-in speechSynthesis.

export interface PlayRequest {
  requestId: number;
  text: string;
  voiceId: string;
  lang: string;
  rate: number;
  /** Upcoming sentences to fetch ahead of time (natural engine only). */
  prefetch: string[];
}

export type EngineEvent =
  | { type: "playing" | "ended"; requestId: number }
  | { type: "error"; requestId: number; message: string }
  /** Another tab took over audio playback. */
  | { type: "interrupted" }
  /** The player lost its state (e.g. Chrome closed the idle offscreen document); restart the sentence. */
  | { type: "lost" };

export interface AudioEngine {
  play(req: PlayRequest): void;
  pause(): void;
  resume(): void;
  stop(): void;
  setRate(rate: number): void;
  onEvent(listener: (e: EngineEvent) => void): () => void;
}

// ---------- messages shared by content script, background and offscreen ----------

export type EngineCommand =
  | ({ type: "play" } & PlayRequest)
  | { type: "pause" }
  | { type: "resume" }
  | { type: "stop" }
  | { type: "rate"; rate: number };

/** content script -> background */
export interface ToBackground {
  target: "background";
  command?: EngineCommand;
  action?: "open-options";
  /** Options page section to open, e.g. "file-access". */
  hash?: string;
  doc?: DocRequest;
  frames?: FrameRequest;
  /** Fetch text with the extension's host permissions (cross-origin, with cookies). */
  fetchText?: string;
}

export type FrameRequest =
  | { op: "extract"; mode: "article" | "page" }
  | { op: "highlight"; frameId: number; index: number; highlight: boolean; scroll: boolean }
  | { op: "clear"; frameId: number };

export interface FrameExtract {
  frameId: number;
  texts: string[];
  chars: number;
}

/** background -> offscreen */
export type ToOffscreen =
  | {
      target: "offscreen";
      tabId: number;
      command: EngineCommand;
      /** Voice service settings; offscreen documents can't read chrome.storage. */
      server: { url: string; apiKey: string };
    }
  | { target: "offscreen"; tabId: number; job: DocJob };

/** offscreen -> background -> content script */
export interface EngineEventMessage {
  target: "tab";
  tabId: number;
  event?: EngineEvent;
  docEvent?: DocEvent;
}

export class Emitter<T> {
  private listeners = new Set<(e: T) => void>();
  on(listener: (e: T) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(e: T): void {
    for (const l of this.listeners) l(e);
  }
}

/** Natural voice: forwards commands to the offscreen document. */
export class ExtensionAudioEngine implements AudioEngine {
  private events = new Emitter<EngineEvent>();

  constructor() {
    browser.runtime.onMessage.addListener((msg: { type?: string; event?: EngineEvent }) => {
      if (msg?.type === "voix:engine-event" && msg.event) this.events.emit(msg.event);
    });
  }

  private send(command: EngineCommand) {
    const msg: ToBackground = { target: "background", command };
    browser.runtime.sendMessage(msg).catch(() => {
      if (command.type === "play") {
        this.events.emit({ type: "error", requestId: command.requestId, message: "Extension background unavailable" });
      }
    });
  }

  play(req: PlayRequest) { this.send({ type: "play", ...req }); }
  pause() { this.send({ type: "pause" }); }
  resume() { this.send({ type: "resume" }); }
  stop() { this.send({ type: "stop" }); }
  setRate(rate: number) { this.send({ type: "rate", rate }); }
  onEvent(listener: (e: EngineEvent) => void) { return this.events.on(listener); }
}

/** Fallback: the browser's built-in voice. Rate changes apply from the next sentence. */
export class SpeechSynthesisEngine implements AudioEngine {
  private events = new Emitter<EngineEvent>();
  private current = 0;

  static available(): boolean {
    return typeof speechSynthesis !== "undefined";
  }

  play(req: PlayRequest) {
    this.current = req.requestId;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(req.text);
    u.lang = req.lang;
    u.rate = req.rate;
    const voice = speechSynthesis.getVoices().find((v) => v.lang === req.lang && v.localService)
      ?? speechSynthesis.getVoices().find((v) => v.lang.startsWith("en"));
    if (voice) u.voice = voice;
    const id = req.requestId;
    u.onstart = () => id === this.current && this.events.emit({ type: "playing", requestId: id });
    u.onend = () => id === this.current && this.events.emit({ type: "ended", requestId: id });
    u.onerror = (e) => {
      // "interrupted"/"canceled" are our own cancel() calls, not failures.
      if (id !== this.current || e.error === "interrupted" || e.error === "canceled") return;
      this.events.emit({ type: "error", requestId: id, message: `Device voice failed: ${e.error}` });
    };
    speechSynthesis.speak(u);
  }
  pause() { speechSynthesis.pause(); }
  resume() { speechSynthesis.resume(); }
  stop() { this.current = -1; speechSynthesis.cancel(); }
  setRate() {}
  onEvent(listener: (e: EngineEvent) => void) { return this.events.on(listener); }
}
