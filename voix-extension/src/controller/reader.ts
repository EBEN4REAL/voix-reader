import { browserLanguages, type Detection } from "../lang/detect";
import {
  BUNDLED_REGISTRY, DEFAULT_GENDER, findLanguage, isReadable, languageName, voiceBelongs, type Gender, type Registry,
} from "../lang/registry";
import { languageConflict, languageOptions, resolveLanguage, textLanguageGuess, voiceState } from "../lang/resolve";
import { TranslationError, type TextTranslator } from "../lang/translate";
import { loadPrefs, savePrefs, saveSiteLanguage } from "../storage";
import type { AudioEngine, EngineEvent } from "./engine";
import { StateStore } from "./store";
import {
  clampSpeed, type ReaderController, type ReaderState, type ReadingLanguage, type Sentence, type SettingKey,
} from "./types";

const PREFETCH = 2;

export interface ReaderOptions {
  /** Website whose language choice is remembered (location.hostname). */
  site?: string;
  /** Fetch the voice registry from the server again, after it refused a language or voice. */
  refreshRegistry?: () => Promise<Registry | null>;
  /** Translates the text when the user listens in another language (Chrome's built-in translator). */
  translator?: TextTranslator;
}

/** First sentence of the paragraph a sentence is in (the sentence itself if paragraphs are unknown). */
export function paragraphStart(sentences: Sentence[], index: number): number {
  const para = sentences[index]?.para;
  if (para === undefined) return index;
  let i = index;
  while (i > 0 && sentences[i - 1]!.para === para) i--;
  return i;
}

/**
 * Real controller: plays sentences through the natural-voice engine and
 * switches to the device voice automatically if it fails, so playback never
 * stops silently. Reads each article in its own language: detection decides
 * unless the user chose a language for the website.
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

  private registry: Registry = BUNDLED_REGISTRY;
  private detection: Detection | null = null;
  private siteChoice: string | undefined;
  /** Chosen for the current text after a language-conflict warning; cleared by the next text. */
  private articleChoice: string | undefined;
  private gender: Gender = DEFAULT_GENDER;
  private voiceByLang: Record<string, string> = {};
  /** Languages the voice service refused this session. */
  private refused = new Set<string>();
  /** The picker was opened by Play: start reading once a language is chosen. */
  private playAfterPick = false;
  /** Reading a language Voix has no natural voice for with the device voice, by the user's choice. */
  private deviceOnly = false;
  /** One registry reload and retry per voice/language mismatch. */
  private mismatchRetried = false;
  /** Changes with every new text, so late translations of an old one are dropped. */
  private textToken = 0;
  /** Pairs that failed to translate this session ("en|de"): read in the text's own language instead. */
  private untranslatable = new Set<string>();
  /** The background translation pass that is running ("token|from|to"). */
  private translatingAhead = "";

  private canTranslate = (from: string, to: string): boolean =>
    !!this.opts.translator && !this.untranslatable.has(`${from}|${to}`) && this.opts.translator.problem(from, to) === null;

  constructor(private natural: AudioEngine, private fallback: AudioEngine | null, private opts: ReaderOptions = {}) {
    super({
      status: "idle",
      sentences: [],
      currentIndex: 0,
      speed: 1,
      voiceId: "",
      voices: [],
      usingFallbackVoice: false,
      settings: { highlightOnPage: true, autoScroll: true },
      multilingual: false,
      languages: languageOptions(BUNDLED_REGISTRY),
      language: null,
      languagePickerOpen: false,
      deviceVoiceAvailable: false,
    });
    natural.onEvent((e) => this.onEngineEvent(e, false));
    fallback?.onEvent((e) => this.onEngineEvent(e, true));
    this.resolve();
  }

  async loadPrefs(): Promise<void> {
    const p = await loadPrefs([
      "speed", "voiceId", "gender", "voiceByLang", "langByHost", "multilingual", "highlightOnPage", "autoScroll",
    ]);
    const legacyVoice = findLanguage("en", this.registry)?.voices.find((v) => v.id === p.voiceId);
    this.gender = p.gender ?? legacyVoice?.gender ?? DEFAULT_GENDER;
    this.voiceByLang = { ...(legacyVoice ? { en: legacyVoice.id } : {}), ...p.voiceByLang };
    this.siteChoice = this.opts.site ? p.langByHost[this.opts.site] : undefined;
    this.update({
      speed: clampSpeed(p.speed),
      multilingual: p.multilingual,
      settings: { highlightOnPage: p.highlightOnPage, autoScroll: p.autoScroll },
    });
    this.resolve();
  }

  // ----- languages -----

  setRegistry(registry: Registry): void {
    this.registry = registry;
    this.update({ languages: languageOptions(registry) });
    this.resolve();
  }

  setMultilingual(on: boolean): void {
    this.update({ multilingual: on });
    this.resolve();
  }

  /** The detected language of the text being read (ignored while the user's site choice applies). */
  applyDetection(detection: Detection | null): void {
    this.detection = detection;
    this.resolve();
  }

  setLanguage(code: string): void {
    const entry = findLanguage(code, this.registry);
    if (!isReadable(entry)) return;
    const multilingual = this.state.multilingual;
    // What the text is in, as best known (detection may not be sure, e.g. a page of short headings).
    const from = multilingual ? textLanguageGuess(this.detection, entry.code, this.registry) : null;
    const translatable = !!from && this.canTranslate(from, entry.code);
    const clearlyOther = multilingual ? languageConflict(this.detection, entry.code, this.registry) : null;
    if (clearlyOther && !translatable) {
      // Can't translate here: ask before reading, say, English text with a German voice.
      this.update({ languageConflict: {
        code: entry.code, name: entry.name, textName: languageName(clearlyOther, this.registry),
        reason: this.opts.translator?.problem(clearlyOther, entry.code) ?? "no-translator",
      } });
      return;
    }
    // Listening in another language: start getting it ready now, inside the user's click
    // (the first time, Chrome downloads the language pack and needs that click).
    if (translatable) this.prepareTranslation(from!, entry.code);
    this.siteChoice = entry.code;
    this.articleChoice = undefined;
    if (this.opts.site) void saveSiteLanguage(this.opts.site, entry.code);
    this.applyChoice();
  }

  confirmLanguageChoice(): void {
    const conflict = this.state.languageConflict;
    if (!conflict) return;
    this.articleChoice = conflict.code; // this text only: never remembered for the site
    this.applyChoice();
  }

  cancelLanguageChoice(): void {
    this.playAfterPick = false;
    this.update({ languageConflict: undefined, languagePickerOpen: false });
  }

  private applyChoice(): void {
    const start = this.playAfterPick;
    this.playAfterPick = false;
    this.update({ languagePickerOpen: false, languageConflict: undefined });
    this.resolve(); // restarts from the start of the paragraph if reading
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
    if (this.opts.site) void saveSiteLanguage(this.opts.site, null);
    this.update({ languagePickerOpen: false });
    this.resolve();
  }

  useDeviceVoice(): void {
    const l = this.state.language;
    if (!l || l.supported || !this.fallback) return;
    this.deviceOnly = true;
    this.natural.stop();
    this.update({ usingFallbackVoice: true });
    this.play();
  }

  /** Work out the reading language and its voice; restart reading if the language changed. */
  private resolve(): void {
    const before = this.state.language;
    const language = resolveLanguage({
      registry: this.registry,
      multilingual: this.state.multilingual,
      detection: this.detection,
      siteChoice: this.siteChoice,
      articleChoice: this.articleChoice,
      refused: this.refused,
      canTranslate: this.canTranslate,
    });
    const changed = before?.code !== language?.code || before?.supported !== language?.supported
      || before?.translatedFrom?.code !== language?.translatedFrom?.code;
    const patch: Partial<ReaderState> = {
      language,
      ...voiceState(language, this.gender, this.registry, this.voiceByLang),
      deviceVoiceAvailable: !!language && !!this.fallback && (this.fallback.supports?.(language.code) ?? true),
      translateOffer: this.translateOffer(language),
    };
    if (changed && this.deviceOnly) {
      this.deviceOnly = false;
      patch.usingFallbackVoice = false; // a language with natural voices: try them again
    }
    this.update(patch);
    if (changed) this.restartForLanguage();
  }

  /** Voix can't read this language, but can translate it into one it reads (the browser's first, else English). */
  private translateOffer(language: ReadingLanguage | null): ReaderState["translateOffer"] {
    if (!language || language.supported || !this.state.multilingual) return undefined;
    const candidates = [...browserLanguages(), "en"].map((tag) => findLanguage(tag, this.registry));
    const target = candidates.find((l) => isReadable(l) && l.code !== language.code && this.canTranslate(language.code, l.code));
    return target ? { code: target.code, name: target.name } : undefined;
  }

  /** The language changed under the reader: drop queued audio, go back to the paragraph start. */
  private restartForLanguage(): void {
    const { status, sentences, currentIndex } = this.state;
    if (!sentences.length) return;
    const start = paragraphStart(sentences, currentIndex);
    if (status === "playing" || status === "preparing") {
      this.halt(); // stop the old language's audio and anything it fetched ahead
      if (this.speakable()) return this.startAt(start);
      this.started = false;
      this.update({ status: "idle", currentIndex: start });
    } else if (status === "paused") {
      this.needsRestart = true;
      this.update({ currentIndex: start });
    }
  }

  private speakable(): boolean {
    const l = this.state.language;
    return !!l && !l.needsConfirm && (l.supported || this.deviceOnly);
  }

  /** Whether reading may start; if the language isn't confirmed, open the picker and wait. */
  private gate(): boolean {
    const l = this.state.language;
    if (!l) return false;
    if (l.needsConfirm && !this.deviceOnly) {
      this.playAfterPick = true;
      this.update({ languagePickerOpen: true });
      return false;
    }
    return l.supported || this.deviceOnly;
  }

  // ----- loading text -----

  /** New text to read. detection: its language (undefined keeps the current one). */
  load(sentences: Sentence[], detection?: Detection | null): void {
    this.halt();
    this.articleChoice = undefined;
    this.textToken++;
    this.update({ languageConflict: undefined, translated: undefined, translationNotice: undefined });
    this.started = false;
    this.loading = this.autoplay = this.waitingForMore = false;
    this.mismatchRetried = false;
    this.update({ sentences, currentIndex: 0, status: "idle", error: undefined, loadingMessage: undefined });
    if (detection !== undefined) this.applyDetection(detection);
  }

  // ----- streaming documents: prepare() -> append()* -> finishLoading() | fail() -----

  /** Show "Preparing voice" while the text is extracted; reading starts with the first append(). */
  prepare(message: string): void {
    this.halt();
    this.started = false;
    this.loading = this.autoplay = true;
    this.waitingForMore = false;
    this.mismatchRetried = false;
    this.detection = null; // a new document: its language is detected from its first text
    this.articleChoice = undefined;
    this.textToken++;
    this.update({ languageConflict: undefined, translated: undefined, translationNotice: undefined });
    this.update({ sentences: [], currentIndex: 0, status: "preparing", error: undefined, loadingMessage: message });
    this.resolve();
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
      if (this.gate()) this.startAt(0);
      else this.update({ status: "idle" }); // waiting for the user to choose a language
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

  // ----- transport -----

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
    if (!this.gate()) return;
    const translatedFrom = this.state.language?.translatedFrom;
    if (translatedFrom) {
      this.update({ translationNotice: undefined });
      this.prepareTranslation(translatedFrom.code, this.state.language!.code); // inside the click
    }
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
    const target = Math.max(0, Math.min(this.state.sentences.length - 1, index));
    if (this.speakable()) return this.startAt(target);
    // Language not settled yet: start from here once it is.
    this.update({ currentIndex: target });
    this.gate();
  }

  setSpeed(speed: number): void {
    const s = clampSpeed(speed);
    this.update({ speed: s });
    this.engine().setRate(s);
    void savePrefs({ speed: s });
  }

  setVoice(voiceId: string): void {
    const voice = this.state.voices.find((v) => v.id === voiceId);
    const lang = this.state.language?.code;
    if (!voice || !lang) return;
    // Takes effect from the next sentence; the current position is kept.
    this.gender = voice.gender;
    this.voiceByLang = { ...this.voiceByLang, [lang]: voiceId };
    this.update({ voiceId, voiceNotice: undefined });
    void savePrefs({ gender: voice.gender, voiceByLang: this.voiceByLang, ...(lang === "en" ? { voiceId } : {}) });
  }

  setSetting(key: SettingKey, value: boolean): void {
    this.update({ settings: { ...this.state.settings, [key]: value } });
    void savePrefs({ [key]: value });
  }

  retryNaturalVoice(): void {
    if (!this.state.usingFallbackVoice || this.deviceOnly) return;
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
    const { sentences, voiceId, voices, speed, language, usingFallbackVoice } = this.state;
    const sentence = sentences[index];
    if (!sentence || !language) return;
    const natural = !(usingFallbackVoice && this.fallback);
    // Never send a voice with a language it doesn't belong to.
    if (natural && !voiceBelongs(voiceId, language.code, this.registry)) {
      this.halt();
      this.update({ status: "error", error: `Voix has no voice for ${language.name}.` });
      return;
    }
    const id = ++this.requestId;
    const voice = voices.find((v) => v.id === voiceId);
    const play = (text: string, prefetch: string[]) => this.engine().play({
      requestId: id,
      text,
      voiceId,
      lang: language.code,
      deviceLang: voice?.locale ?? language.code,
      langSource: language.source,
      engine: voice?.engine,
      rate: speed,
      prefetch,
    });
    this.needsRestart = false;
    const from = language.translatedFrom?.code;
    // Waiting for a translation (the first time, a language pack download) shows "Preparing".
    const waiting = !!from && this.translationOf(index, language.code) === undefined;
    this.update({ currentIndex: index, status: this.started && !waiting ? "playing" : "preparing", error: undefined });
    if (!from) {
      play(sentence.text, sentences.slice(index + 1, index + 1 + PREFETCH).map((s) => s.text));
      return;
    }
    const token = this.textToken;
    this.translations(index, index + 1 + PREFETCH, from, language.code, token).then(
      ([text, ...prefetch]) => {
        if (id !== this.requestId) return; // the user moved on meanwhile
        play(text!, prefetch);
        this.translateAhead(from, language.code, token);
      },
      (e) => {
        if (id === this.requestId) this.translationFailed(e, from, language);
      },
    );
  }

  // ----- translation -----

  private translationOf(index: number, lang: string): string | undefined {
    const t = this.state.translated;
    return t?.lang === lang ? t.texts[index] : undefined;
  }

  /** Translations of sentences [start, end), from what is known or the translator; remembered in state. */
  private async translations(start: number, end: number, from: string, to: string, token: number): Promise<string[]> {
    const sentences = this.state.sentences.slice(start, end);
    const out: string[] = [];
    for (const [i, s] of sentences.entries()) {
      out.push(this.translationOf(start + i, to) ?? await this.opts.translator!.translate(s.text, from, to));
    }
    if (token === this.textToken) {
      const current = this.state.translated;
      const texts = current?.lang === to ? current.texts.slice() : [];
      out.forEach((text, i) => { texts[start + i] = text; });
      this.update({ translated: { lang: to, texts } });
    }
    return out;
  }

  /** Translate the rest of the text in the background: the list shows it, and reading never waits. */
  private translateAhead(from: string, to: string, token: number): void {
    const key = `${token}|${from}|${to}`;
    if (this.translatingAhead === key) return;
    this.translatingAhead = key;
    void (async () => {
      for (let i = 0; i < this.state.sentences.length; i += 5) {
        if (this.translatingAhead !== key || token !== this.textToken || this.state.language?.code !== to) return;
        const end = Math.min(i + 5, this.state.sentences.length);
        const missing = Array.from({ length: end - i }, (_, k) => this.translationOf(i + k, to)).includes(undefined);
        if (!missing) continue;
        try {
          await this.translations(i, end, from, to, token);
        } catch {
          return; // reading itself reports translation problems
        }
      }
    })();
  }

  /** Start getting a translation ready; called from clicks, as Chrome's first download needs one. */
  private prepareTranslation(from: string, to: string): void {
    const translator = this.opts.translator;
    if (!translator || !this.canTranslate(from, to)) return;
    const name = languageName(to, this.registry);
    translator.prepare(from, to, (fraction) => {
      if (fraction < 1) this.update({ loadingMessage: `Getting ${name} ready… ${Math.round(fraction * 100)}%` });
    }).then(
      () => { if (this.state.loadingMessage?.startsWith("Getting ")) this.update({ loadingMessage: undefined }); },
      () => {}, // reading reports it
    );
  }

  private translationFailed(e: unknown, from: string, language: ReadingLanguage): void {
    const fromName = language.translatedFrom?.name ?? languageName(from, this.registry);
    const wasReading = this.state.status === "playing" || this.state.status === "preparing";
    this.halt();
    this.started = false;
    if (e instanceof TranslationError && e.kind === "needs-click") {
      this.update({ status: "idle", loadingMessage: undefined,
        translationNotice: `Press Play to get ${language.name} ready. Chrome downloads it once.` });
      return;
    }
    // This pair can't be translated here after all: read the text in its own language.
    this.untranslatable.add(`${from}|${language.code}`);
    this.update({ status: "idle", loadingMessage: undefined,
      translationNotice: `This browser couldn't translate ${fromName} to ${language.name}, so Voix reads it in ${fromName}.` });
    this.resolve();
    if (wasReading) this.play();
  }

  private advance(): void {
    const nextIndex = this.state.currentIndex + 1;
    if (nextIndex < this.state.sentences.length) this.startAt(nextIndex);
    else if (this.loading) this.waitingForMore = true; // next page is still being extracted
    else this.stop();
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
      this.mismatchRetried = false;
      if (this.state.status === "preparing") this.update({ status: "playing" });
    } else if (e.type === "ended") {
      this.advance();
    } else if (e.type === "error") {
      if (!fromFallback && e.code === "language_not_supported") return this.languageRefused();
      if (!fromFallback && e.code === "voice_language_mismatch") return this.voiceMismatch(e.message);
      if (!fromFallback && e.code === "text_empty_or_too_long") {
        console.warn("[Voix] The voice service refused a sentence; skipping it:", e.message);
        return this.advance();
      }
      const language = this.state.language;
      const deviceCanRead = !!this.fallback && (this.fallback.supports?.(this.deviceLang()) ?? true);
      if (!fromFallback && deviceCanRead) {
        this.natural.stop();
        this.update({ usingFallbackVoice: true });
        this.startAt(this.state.currentIndex);
      } else {
        this.halt();
        const message = !fromFallback && this.fallback && language
          ? `Natural voices are unavailable right now, and this device has no ${language.name} voice.`
          : e.message;
        this.update({ status: "error", error: message });
      }
    }
  }

  private deviceLang(): string {
    const { voices, voiceId, language } = this.state;
    return voices.find((v) => v.id === voiceId)?.locale ?? language?.code ?? "en";
  }

  /** The server can't read this language (disabled since the registry was fetched, or missing there). */
  private languageRefused(): void {
    const code = this.state.language?.code;
    if (code) this.refused.add(code);
    this.halt();
    this.started = false;
    this.update({ status: "idle" });
    this.resolve(); // now unsupported: the widget shows the message and the picker
    void this.opts.refreshRegistry?.().then((r) => r && this.setRegistry(r));
  }

  /** Registry out of date (or a bug): reload it, pick a valid voice, retry the sentence once. */
  private voiceMismatch(message: string): void {
    console.warn("[Voix] Bug: voice and language don't match:", message);
    const { language } = this.state;
    if (this.mismatchRetried || !this.opts.refreshRegistry) {
      this.halt();
      this.update({ status: "error", error: `Voix couldn't find a voice for ${language?.name ?? "this language"}.` });
      return;
    }
    this.mismatchRetried = true;
    const id = this.requestId;
    const index = this.state.currentIndex;
    if (language) {
      const { [language.code]: _bad, ...rest } = this.voiceByLang;
      this.voiceByLang = rest; // the remembered voice may be the wrong one
    }
    void this.opts.refreshRegistry().then((registry) => {
      const { status } = this.state;
      if (id !== this.requestId || (status !== "playing" && status !== "preparing")) return; // user moved on
      if (registry) this.setRegistry(registry);
      else this.resolve();
      this.startAt(index);
    });
  }
}
