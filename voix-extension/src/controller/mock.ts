import { VOICES, DEFAULT_VOICE } from "../voices";
import { StateStore } from "./store";
import { clampSpeed, type ReaderController, type Sentence, type SettingKey } from "./types";

export const SAMPLE_ARTICLE: Sentence[] = [
  "The Quiet Return of the Long Read",
  "For years, the long article looked like a casualty of the scrolling age.",
  "Readers skimmed headlines, saved links for later, and rarely came back to them.",
  "Something has shifted, though, and it has less to do with attention than with where reading happens.",
  "People now read while walking, cooking, and sitting in traffic, and their eyes are often busy elsewhere.",
  "Listening fills that gap without asking anyone to stop what they are doing.",
  "A good narrator turns a saved article into company for a commute.",
  "The challenge is that web pages are messy.",
  "Menus, banners, and adverts surround the text, and a reader that cannot tell the difference will read all of it aloud.",
  "The best tools find the article itself and read only that.",
  "Voix does exactly that, sentence by sentence.",
  "Press play, and the page becomes something you can listen to.",
].map((text, i) => ({ id: `s${i + 1}`, text }));

export interface MockOptions {
  sentences?: Sentence[];
  /** Base time per sentence at 1.0x, in ms. */
  sentenceMs?: number;
  preparingMs?: number;
}

/** Simulated reader that advances through a sample article on a timer. */
export class MockReaderController extends StateStore implements ReaderController {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private readonly sentenceMs: number;
  private readonly preparingMs: number;

  constructor(opts: MockOptions = {}) {
    super({
      status: "idle",
      sentences: opts.sentences ?? SAMPLE_ARTICLE,
      currentIndex: 0,
      speed: 1,
      voiceId: DEFAULT_VOICE,
      voices: VOICES,
      usingFallbackVoice: false,
      settings: { highlightOnPage: true, autoScroll: true },
    });
    this.sentenceMs = opts.sentenceMs ?? 2600;
    this.preparingMs = opts.preparingMs ?? 1400;
  }

  play(): void {
    const { status } = this.state;
    if (status === "playing" || status === "preparing") return;
    if (!this.started) {
      this.update({ status: "preparing", error: undefined });
      this.schedule(this.preparingMs, () => {
        this.started = true;
        this.update({ status: "playing" });
        this.scheduleAdvance();
      });
      return;
    }
    this.update({ status: "playing", error: undefined });
    this.scheduleAdvance();
  }

  pause(): void {
    if (this.state.status !== "playing" && this.state.status !== "preparing") return;
    this.clear();
    this.update({ status: "paused" });
  }

  stop(): void {
    this.clear();
    this.started = false;
    this.update({ status: "idle", currentIndex: 0 });
  }

  next(): void {
    this.jumpTo(this.state.currentIndex + 1);
  }

  previous(): void {
    this.jumpTo(this.state.currentIndex - 1);
  }

  jumpTo(index: number): void {
    const last = this.state.sentences.length - 1;
    const target = Math.max(0, Math.min(last, index));
    this.clear();
    this.update({ currentIndex: target });
    if (this.started) {
      this.update({ status: "playing" });
      this.scheduleAdvance();
    } else {
      this.play();
    }
  }

  setSpeed(speed: number): void {
    this.update({ speed: clampSpeed(speed) });
  }

  setVoice(voiceId: string): void {
    if (this.state.voices.some((v) => v.id === voiceId)) this.update({ voiceId });
  }

  setSetting(key: SettingKey, value: boolean): void {
    this.update({ settings: { ...this.state.settings, [key]: value } });
  }

  retryNaturalVoice(): void {
    this.update({ usingFallbackVoice: false });
  }

  // ----- dev helpers (not part of ReaderController) -----

  simulateFallback(): void {
    this.update({ usingFallbackVoice: true });
    if (this.state.status === "idle") this.play();
  }

  simulateError(message = "Voix couldn't read this page."): void {
    this.clear();
    this.update({ status: "error", error: message });
  }

  restart(): void {
    this.stop();
    this.play();
  }

  dispose(): void {
    this.clear();
  }

  private scheduleAdvance(): void {
    this.schedule(this.sentenceMs / this.state.speed, () => {
      const nextIndex = this.state.currentIndex + 1;
      if (nextIndex >= this.state.sentences.length) return this.stop();
      this.update({ currentIndex: nextIndex });
      this.scheduleAdvance();
    });
  }

  private schedule(ms: number, fn: () => void): void {
    this.clear();
    this.timer = setTimeout(fn, ms);
  }

  private clear(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
