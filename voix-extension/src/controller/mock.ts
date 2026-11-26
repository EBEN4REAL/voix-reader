import type { Detection } from "../lang/detect";
import { BUNDLED_REGISTRY, DEFAULT_GENDER, findLanguage, isReadable, languageName, type Gender } from "../lang/registry";
import { languageConflict, languageOptions, resolveLanguage, textLanguageGuess, voiceState } from "../lang/resolve";
import { StateStore } from "./store";
import { clampSpeed, type ReaderController, type ReaderState, type Sentence, type SettingKey } from "./types";

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
  /** A stand-in translator (dev page, tests): when set, picking another language translates. */
  translate?: (text: string, from: string, to: string) => string;
}

const ENGLISH: Detection = { lang: "en", confidence: 99, source: "text", mixed: false, needsConfirm: false };

/** Simulated reader that advances through a sample article on a timer. */
export class MockReaderController extends StateStore implements ReaderController {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private readonly sentenceMs: number;
  private readonly preparingMs: number;
  private detection: Detection = ENGLISH;
  private siteChoice: string | undefined;
  private articleChoice: string | undefined;
  private fakeTranslate: MockOptions["translate"];
  private canTranslate = (from: string, to: string) => !!this.fakeTranslate && from !== to;
  private gender: Gender = DEFAULT_GENDER;
  private voiceByLang: Record<string, string> = {};
  private playAfterPick = false;

  constructor(opts: MockOptions = {}) {
    super({
      status: "idle",
      sentences: opts.sentences ?? SAMPLE_ARTICLE,
      currentIndex: 0,
      speed: 1,
      voiceId: "",
      voices: [],
      usingFallbackVoice: false,
      settings: { highlightOnPage: true, autoScroll: true },
      multilingual: true,
      languages: languageOptions(BUNDLED_REGISTRY),
      language: null,
      languagePickerOpen: false,
      deviceVoiceAvailable: true,
    });
    this.sentenceMs = opts.sentenceMs ?? 2600;
    this.preparingMs = opts.preparingMs ?? 1400;
    this.fakeTranslate = opts.translate;
    this.resolve();
  }

  play(): void {
    const { status, language } = this.state;
    if (status === "playing" || status === "preparing" || !language) return;
    if (language.needsConfirm) {
      this.playAfterPick = true;
      this.update({ languagePickerOpen: true });
      return;
    }
    if (!language.supported && !this.state.usingFallbackVoice) return;
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
    const voice = this.state.voices.find((v) => v.id === voiceId);
    const lang = this.state.language?.code;
    if (!voice || !lang) return;
    this.gender = voice.gender;
    this.voiceByLang = { ...this.voiceByLang, [lang]: voiceId };
    this.update({ voiceId, voiceNotice: undefined });
  }

  setLanguage(code: string): void {
    const entry = findLanguage(code, BUNDLED_REGISTRY);
    if (!isReadable(entry)) return;
    const from = textLanguageGuess(this.detection, entry.code, BUNDLED_REGISTRY);
    const textLanguage = languageConflict(this.detection, entry.code, BUNDLED_REGISTRY);
    if (textLanguage && !(from && this.canTranslate(from, entry.code))) {
      this.update({ languageConflict: {
        code: entry.code, name: entry.name, textName: languageName(textLanguage, BUNDLED_REGISTRY), reason: "no-translator",
      } });
      return;
    }
    this.siteChoice = entry.code;
    this.articleChoice = undefined;
    this.applyChoice();
  }

  confirmLanguageChoice(): void {
    const conflict = this.state.languageConflict;
    if (!conflict) return;
    this.articleChoice = conflict.code;
    this.applyChoice();
  }

  cancelLanguageChoice(): void {
    this.playAfterPick = false;
    this.update({ languageConflict: undefined, languagePickerOpen: false });
  }

  private applyChoice(): void {
    const start = this.playAfterPick;
    this.playAfterPick = false;
    this.update({ languagePickerOpen: false, languageConflict: undefined, usingFallbackVoice: false });
    this.resolve();
    if (start) this.play();
  }

  openLanguagePicker(): void {
    this.update({ languagePickerOpen: true });
  }

  closeLanguagePicker(): void {
    this.playAfterPick = false;
    this.update({ languagePickerOpen: false, languageConflict: undefined });
  }

  resetSiteLanguage(): void {
    this.siteChoice = undefined;
    this.articleChoice = undefined;
    this.update({ languagePickerOpen: false });
    this.resolve();
  }

  useDeviceVoice(): void {
    if (this.state.language?.supported) return;
    this.update({ usingFallbackVoice: true });
    this.play();
  }

  setSetting(key: SettingKey, value: boolean): void {
    this.update({ settings: { ...this.state.settings, [key]: value } });
  }

  retryNaturalVoice(): void {
    this.update({ usingFallbackVoice: false });
  }

  // ----- dev helpers (not part of ReaderController) -----

  /** Pretend detection found this language (dev page states). */
  simulateDetection(detection: Detection, preferredGender: Gender = this.gender): void {
    this.clear();
    this.started = false;
    this.detection = detection;
    this.siteChoice = undefined;
    this.articleChoice = undefined;
    this.gender = preferredGender;
    this.update({ status: "idle", currentIndex: 0, usingFallbackVoice: false, languagePickerOpen: false });
    this.resolve();
  }

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

  private resolve(): void {
    const language = resolveLanguage({
      registry: BUNDLED_REGISTRY, multilingual: this.state.multilingual,
      detection: this.detection, siteChoice: this.siteChoice, articleChoice: this.articleChoice,
      canTranslate: this.canTranslate,
    });
    const from = language?.translatedFrom?.code;
    const english = findLanguage("en", BUNDLED_REGISTRY)!;
    const patch: Partial<ReaderState> = {
      language, ...voiceState(language, this.gender, BUNDLED_REGISTRY, this.voiceByLang),
      translated: from && this.fakeTranslate && language
        ? { lang: language.code, texts: this.state.sentences.map((s) => this.fakeTranslate!(s.text, from, language.code)) }
        : undefined,
      translateOffer: language && !language.supported && this.canTranslate(language.code, "en")
        ? { code: english.code, name: english.name } : undefined,
    };
    this.update(patch);
  }
}
