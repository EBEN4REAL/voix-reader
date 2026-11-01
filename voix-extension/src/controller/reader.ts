import { loadPrefs, savePrefs } from "../storage";
import { DEFAULT_VOICE, VOICES, voiceLang } from "../voices";
import type { AudioEngine, EngineEvent } from "./engine";
import { StateStore } from "./store";
import { clampSpeed, type ReaderController, type Sentence, type SettingKey } from "./types";

const PREFETCH = 2;

/**
 * Real controller: plays sentences through the natural-voice engine and
 * switches to the device voice automatically if it fails, so playback never
 * stops silently.
 */
export class VoixReaderController extends StateStore implements ReaderController {
  private requestId = 0;
  /** True once the first audio of this session has started (ends the "preparing" state). */
  private started = false;
  /** Audio was interrupted by another tab; resuming must restart the sentence. */
  private needsRestart = false;
  /** More sentences are still arriving (PDF pages, OCR). */
  private loading = false;
  /** Start reading as soon as the first sentences arrive. */
  private autoplay = false;
  /** Reached the last available sentence while more are still loading. */
  private waitingForMore = false;

  constructor(private natural: AudioEngine, private fallback: AudioEngine | null) {
    super({
      status: "idle",
      sentences: [],
      currentIndex: 0,
      speed: 1,
      voiceId: DEFAULT_VOICE,
      voices: VOICES,
      usingFallbackVoice: false,
      settings: { highlightOnPage: true, autoScroll: true },
    });
    natural.onEvent((e) => this.onEngineEvent(e, false));
    fallback?.onEvent((e) => this.onEngineEvent(e, true));
  }

  async loadPrefs(): Promise<void> {
    const p = await loadPrefs(["speed", "voiceId", "highlightOnPage", "autoScroll"]);
    this.update({
      speed: clampSpeed(p.speed),
      voiceId: VOICES.some((v) => v.id === p.voiceId) ? p.voiceId : DEFAULT_VOICE,
      settings: { highlightOnPage: p.highlightOnPage, autoScroll: p.autoScroll },
    });
  }

  load(sentences: Sentence[]): void {
    this.halt();
    this.started = false;
    this.loading = this.autoplay = this.waitingForMore = false;
    this.update({ sentences, currentIndex: 0, status: "idle", error: undefined, loadingMessage: undefined });
  }

  // ----- streaming documents: prepare() -> append()* -> finishLoading() | fail() -----

  /** Show "Preparing voice" while the text is extracted; reading starts with the first append(). */
  prepare(message: string): void {
    this.halt();
    this.started = false;
    this.loading = this.autoplay = true;
    this.waitingForMore = false;
    this.update({ sentences: [], currentIndex: 0, status: "preparing", error: undefined, loadingMessage: message });
  }

  setLoadingMessage(message: string): void {
    this.update({ loadingMessage: message });
  }

  append(more: Sentence[]): void {
    if (!more.length) return;
    const wasEmpty = this.state.sentences.length === 0;
    this.update({ sentences: [...this.state.sentences, ...more] });
    if (wasEmpty && this.autoplay) {
      this.autoplay = false;
      this.startAt(0);
    } else if (this.waitingForMore) {
      this.waitingForMore = false;
      this.startAt(this.state.currentIndex + 1);
    }
  }

  finishLoading(emptyMessage = "No readable text was found."): void {
    this.loading = this.autoplay = false;
    this.update({ loadingMessage: undefined });
    if (!this.state.sentences.length) return this.fail(emptyMessage);
    if (this.waitingForMore) {
      this.waitingForMore = false;
      this.stop();
    }
  }

  fail(message: string): void {
    this.loading = this.autoplay = this.waitingForMore = false;
    this.halt();
    this.update({ status: "error", error: message, loadingMessage: undefined });
  }

  play(): void {
    const { status, sentences, currentIndex } = this.state;
    if (!sentences.length) {
      if (this.loading && status !== "preparing") {
        this.autoplay = true;
        this.update({ status: "preparing" });
      }
      return;
    }
    if (status === "playing" || status === "preparing") return;
    if (status === "paused" && !this.needsRestart) {
      this.engine().resume();
      this.update({ status: this.started ? "playing" : "preparing" });
      return;
    }
    this.startAt(currentIndex);
  }

  pause(): void {
    const { status } = this.state;
    if (status !== "playing" && status !== "preparing") return;
    this.autoplay = false;
    if (!this.state.sentences.length) this.needsRestart = true; // nothing playing yet: Play must start, not resume
    this.engine().pause();
    this.update({ status: "paused" });
  }

  stop(): void {
    this.halt();
    this.started = false;
    this.autoplay = this.waitingForMore = false;
    this.update({ status: "idle", currentIndex: 0 });
  }

  next(): void { this.jumpTo(this.state.currentIndex + 1); }
  previous(): void { this.jumpTo(this.state.currentIndex - 1); }

  jumpTo(index: number): void {
    if (!this.state.sentences.length) return;
    this.startAt(Math.max(0, Math.min(this.state.sentences.length - 1, index)));
  }

  setSpeed(speed: number): void {
    const s = clampSpeed(speed);
    this.update({ speed: s });
    this.engine().setRate(s);
    void savePrefs({ speed: s });
  }

  setVoice(voiceId: string): void {
    if (!VOICES.some((v) => v.id === voiceId)) return;
    // Takes effect from the next sentence; the current position is kept.
    this.update({ voiceId });
    void savePrefs({ voiceId });
  }

  setSetting(key: SettingKey, value: boolean): void {
    this.update({ settings: { ...this.state.settings, [key]: value } });
    void savePrefs({ [key]: value });
  }

  retryNaturalVoice(): void {
    if (!this.state.usingFallbackVoice) return;
    this.fallback?.stop();
    this.update({ usingFallbackVoice: false });
    const { status } = this.state;
    if (status === "playing" || status === "preparing") this.startAt(this.state.currentIndex);
    else if (status === "paused") this.needsRestart = true; // the natural engine has nothing loaded
  }

  private engine(): AudioEngine {
    return this.state.usingFallbackVoice && this.fallback ? this.fallback : this.natural;
  }

  private halt(): void {
    this.requestId++;
    this.needsRestart = false;
    this.natural.stop();
    this.fallback?.stop();
  }

  private startAt(index: number): void {
    const { sentences, voiceId, speed } = this.state;
    const sentence = sentences[index];
    if (!sentence) return;
    const id = ++this.requestId;
    this.needsRestart = false;
    this.update({ currentIndex: index, status: this.started ? "playing" : "preparing", error: undefined });
    const voice = VOICES.find((v) => v.id === voiceId);
    this.engine().play({
      requestId: id,
      text: sentence.text,
      voiceId,
      lang: voiceLang(voice),
      rate: speed,
      prefetch: sentences.slice(index + 1, index + 1 + PREFETCH).map((s) => s.text),
    });
  }

  private onEngineEvent(e: EngineEvent, fromFallback: boolean): void {
    if (fromFallback !== (this.state.usingFallbackVoice && !!this.fallback)) return; // stale engine
    if (e.type === "lost") {
      const { status } = this.state;
      if (status === "playing" || status === "preparing") this.startAt(this.state.currentIndex);
      else if (status === "paused") this.needsRestart = true;
      return;
    }
    if (e.type === "interrupted") {
      if (this.state.status === "playing" || this.state.status === "preparing") {
        this.needsRestart = true;
        this.update({ status: "paused" });
      }
      return;
    }
    if (e.requestId !== this.requestId) return; // superseded by a newer request

    if (e.type === "playing") {
      this.started = true;
      if (this.state.status === "preparing") this.update({ status: "playing" });
    } else if (e.type === "ended") {
      const nextIndex = this.state.currentIndex + 1;
      if (nextIndex < this.state.sentences.length) this.startAt(nextIndex);
      else if (this.loading) this.waitingForMore = true; // next page is still being extracted
      else this.stop();
    } else if (e.type === "error") {
      if (!fromFallback && this.fallback) {
        this.natural.stop();
        this.update({ usingFallbackVoice: true });
        this.startAt(this.state.currentIndex);
      } else {
        this.halt();
        this.update({ status: "error", error: e.message });
      }
    }
  }
}
