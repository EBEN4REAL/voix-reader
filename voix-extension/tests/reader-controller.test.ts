import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioEngine, EngineEvent, PlayRequest } from "../src/controller/engine";
import { Emitter } from "../src/controller/engine";
import { paragraphStart, VoixReaderController } from "../src/controller/reader";
import type { Detection } from "../src/lang/detect";
import { BUNDLED_REGISTRY, type Registry } from "../src/lang/registry";
import { TranslationError, type TextTranslator, type TranslationProblem } from "../src/lang/translate";
import { loadPrefs } from "../src/storage";

vi.mock("wxt/browser", () => ({ browser: {} }));

class FakeEngine implements AudioEngine {
  events = new Emitter<EngineEvent>();
  plays: PlayRequest[] = [];
  calls: string[] = [];
  rate = 1;
  play(req: PlayRequest) { this.plays.push(req); this.calls.push("play"); }
  pause() { this.calls.push("pause"); }
  resume() { this.calls.push("resume"); }
  stop() { this.calls.push("stop"); }
  setRate(rate: number) { this.rate = rate; }
  onEvent(l: (e: EngineEvent) => void) { return this.events.on(l); }
  get last() { return this.plays[this.plays.length - 1]!; }
  fire(type: "playing" | "ended") { this.events.emit({ type, requestId: this.last.requestId }); }
  fail(message = "boom", code?: string) { this.events.emit({ type: "error", requestId: this.last.requestId, message, code }); }
  /** Languages this engine can speak (device voices); all when unset. */
  speaks: string[] | null = null;
  supports(lang: string) { return !this.speaks || this.speaks.includes(lang.split("-")[0]!); }
}

const SENTENCES = ["One.", "Two.", "Three."].map((text, i) => ({ id: `s${i}`, text }));

describe("VoixReaderController", () => {
  let natural: FakeEngine;
  let fallback: FakeEngine;
  let c: VoixReaderController;

  beforeEach(() => {
    natural = new FakeEngine();
    fallback = new FakeEngine();
    c = new VoixReaderController(natural, fallback);
    c.load(SENTENCES);
  });

  it("is preparing until the first audio starts, then playing", () => {
    c.play();
    expect(c.getState().status).toBe("preparing");
    expect(natural.last).toMatchObject({
      text: "One.", voiceId: "af_heart", lang: "en", deviceLang: "en-US", prefetch: ["Two.", "Three."],
    });
    natural.fire("playing");
    expect(c.getState().status).toBe("playing");
  });

  it("moves to the next sentence when one ends and stops after the last", () => {
    c.play();
    natural.fire("playing");
    natural.fire("ended");
    expect(c.getState().currentIndex).toBe(1);
    expect(c.getState().status).toBe("playing"); // later sentences don't show "preparing" again
    natural.fire("ended");
    natural.fire("ended");
    expect(c.getState()).toMatchObject({ status: "idle", currentIndex: 0 });
  });

  it("pauses and resumes without restarting the sentence", () => {
    c.play();
    natural.fire("playing");
    c.pause();
    expect(c.getState().status).toBe("paused");
    c.play();
    expect(natural.calls.slice(-2)).toEqual(["pause", "resume"]);
    expect(natural.plays).toHaveLength(1);
  });

  it("ignores events from superseded requests", () => {
    c.play();
    const first = natural.last.requestId;
    c.jumpTo(2);
    natural.events.emit({ type: "ended", requestId: first });
    expect(c.getState().currentIndex).toBe(2);
  });

  it("falls back to the device voice on error and keeps reading", () => {
    c.play();
    natural.fire("playing");
    natural.fire("ended");
    natural.fail("HTTP 503");
    const s = c.getState();
    expect(s.usingFallbackVoice).toBe(true);
    expect(s.currentIndex).toBe(1);
    expect(fallback.last).toMatchObject({ text: "Two." });
    fallback.fire("playing");
    fallback.fire("ended");
    expect(fallback.last).toMatchObject({ text: "Three." });
  });

  it("try natural voice switches back from the current sentence", () => {
    c.play();
    natural.fail();
    fallback.fire("playing");
    c.retryNaturalVoice();
    expect(c.getState().usingFallbackVoice).toBe(false);
    expect(natural.last).toMatchObject({ text: "One." });
    expect(fallback.calls).toContain("stop");
  });

  it("reports an error only when the fallback also fails", () => {
    c.play();
    natural.fail();
    fallback.fail("no voices");
    expect(c.getState()).toMatchObject({ status: "error", error: "no voices" });
  });

  it("applies speed immediately and voice from the next sentence", () => {
    c.play();
    natural.fire("playing");
    c.setSpeed(1.5);
    expect(natural.rate).toBe(1.5);
    c.setVoice("bm_george");
    expect(natural.plays).toHaveLength(1); // current sentence not restarted
    natural.fire("ended");
    expect(natural.last).toMatchObject({ voiceId: "bm_george", lang: "en", deviceLang: "en-GB", rate: 1.5 });
  });

  it("pauses when another tab takes over and restarts the sentence on resume", () => {
    c.play();
    natural.fire("playing");
    natural.events.emit({ type: "interrupted" });
    expect(c.getState().status).toBe("paused");
    c.play();
    expect(natural.plays).toHaveLength(2);
    expect(natural.last.text).toBe("One.");
  });

  it("stop halts both engines and returns to the start", () => {
    c.play();
    natural.fire("playing");
    natural.fire("ended");
    c.stop();
    expect(c.getState()).toMatchObject({ status: "idle", currentIndex: 0 });
    expect(natural.calls).toContain("stop");
    expect(fallback.calls).toContain("stop");
  });
});

describe("VoixReaderController streaming (PDF pages, OCR)", () => {
  let natural: FakeEngine;
  let c: VoixReaderController;
  const more = (from: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `p${from + i}`, text: `Sentence ${from + i}.` }));

  beforeEach(() => {
    natural = new FakeEngine();
    c = new VoixReaderController(natural, new FakeEngine());
  });

  it("shows preparing with a message, then starts on the first sentences", () => {
    c.prepare("Opening PDF…");
    expect(c.getState()).toMatchObject({ status: "preparing", loadingMessage: "Opening PDF…", sentences: [] });
    c.setLoadingMessage("Recognising text on page 1 of 3…");
    c.append(more(0, 2));
    expect(natural.last.text).toBe("Sentence 0.");
    natural.fire("playing");
    expect(c.getState().status).toBe("playing");
  });

  it("waits at the end of the loaded text and continues when the next page arrives", () => {
    c.prepare("Opening PDF…");
    c.append(more(0, 1));
    natural.fire("playing");
    natural.fire("ended");
    expect(natural.plays).toHaveLength(1); // nothing to play yet
    c.append(more(1, 2));
    expect(natural.last.text).toBe("Sentence 1.");
    expect(c.getState().sentences).toHaveLength(3);
  });

  it("finishes after the last page", () => {
    c.prepare("Opening PDF…");
    c.append(more(0, 1));
    natural.fire("playing");
    natural.fire("ended");
    c.finishLoading();
    expect(c.getState().status).toBe("idle");
  });

  it("fails clearly when a document has no text", () => {
    c.prepare("Opening PDF…");
    c.finishLoading("This PDF has no readable text.");
    expect(c.getState()).toMatchObject({ status: "error", error: "This PDF has no readable text." });
  });

  it("doesn't autoplay if paused while loading", () => {
    c.prepare("Opening PDF…");
    c.pause();
    c.append(more(0, 2));
    expect(natural.plays).toHaveLength(0);
    c.play();
    expect(natural.plays).toHaveLength(1);
  });

  it("restarts the sentence when the player lost its state", () => {
    c.load(more(0, 3));
    c.play();
    natural.fire("playing");
    c.pause();
    c.play(); // resume
    natural.events.emit({ type: "lost" });
    expect(natural.plays).toHaveLength(2);
    expect(natural.last.text).toBe("Sentence 0.");
  });
});

describe("VoixReaderController languages", () => {
  let natural: FakeEngine;
  let fallback: FakeEngine;
  let refreshRegistry: ReturnType<typeof vi.fn<() => Promise<Registry | null>>>;
  let c: VoixReaderController;

  const detected = (lang: string | null, extra: Partial<Detection> = {}): Detection =>
    ({ lang, confidence: 95, source: "text", mixed: false, needsConfirm: false, ...extra });
  // Two paragraphs of two sentences each, then one more.
  const ARTICLE = [
    { id: "s0", text: "Uno.", para: 0 }, { id: "s1", text: "Dos.", para: 0 },
    { id: "s2", text: "Tres.", para: 1 }, { id: "s3", text: "Cuatro.", para: 1 },
    { id: "s4", text: "Cinco.", para: 2 },
  ];
  const settle = () => new Promise((r) => setTimeout(r, 0));

  async function make(site = "news.example") {
    const ctl = new VoixReaderController(natural, fallback, { site, refreshRegistry });
    await ctl.loadPrefs();
    ctl.setMultilingual(true);
    return ctl;
  }

  beforeEach(async () => {
    natural = new FakeEngine();
    fallback = new FakeEngine();
    refreshRegistry = vi.fn(async () => BUNDLED_REGISTRY);
    c = await make();
  });

  it("keeps Play disabled until the language is known", () => {
    c.load(ARTICLE);
    expect(c.getState().language).toBeNull();
    c.play();
    expect(natural.plays).toHaveLength(0);
  });

  it("reads a confidently detected language with its voice and code", () => {
    c.load(ARTICLE, detected("es"));
    c.play();
    expect(c.getState().language).toMatchObject({ code: "es", name: "Spanish", source: "auto", supported: true, beta: true });
    expect(natural.last).toMatchObject({ text: "Uno.", voiceId: "ef_dora", lang: "es", deviceLang: "es-ES", langSource: "auto" });
    expect(c.getState().voices.map((v) => v.id)).toEqual(["ef_dora", "em_alex", "em_santa"]);
  });

  it("sends Portuguese from Portugal as pt with the Brazilian voice", () => {
    c.load(ARTICLE, detected("pt"));
    c.play();
    expect(natural.last).toMatchObject({ voiceId: "pf_dora", lang: "pt", deviceLang: "pt-BR" });
  });

  it("asks before reading when detection isn't sure, then reads the chosen language", async () => {
    c.load(ARTICLE, detected("es", { confidence: 55, needsConfirm: true }));
    expect(c.getState().language).toMatchObject({ code: "es", needsConfirm: true });
    c.play();
    expect(c.getState().languagePickerOpen).toBe(true);
    expect(natural.plays).toHaveLength(0);
    c.setLanguage("it");
    expect(c.getState()).toMatchObject({ languagePickerOpen: false, language: { code: "it", source: "user", needsConfirm: false } });
    expect(natural.last).toMatchObject({ text: "Uno.", voiceId: "if_sara", lang: "it" });
    await settle();
    expect((await loadPrefs(["langByHost"])).langByHost).toEqual({ "news.example": "it" });
  });

  it("closing the picker doesn't start reading", () => {
    c.load(ARTICLE, detected("es", { needsConfirm: true }));
    c.play();
    c.closeLanguagePicker();
    c.openLanguagePicker();
    c.setLanguage("es");
    expect(natural.plays).toHaveLength(0);
  });

  it("never sends a language Voix can't read; the device voice is offered instead", () => {
    c.load(ARTICLE, detected("tr"));
    c.play();
    expect(c.getState()).toMatchObject({
      language: { code: "tr", name: "Turkish", supported: false }, voices: [], deviceVoiceAvailable: true,
    });
    expect(natural.plays).toHaveLength(0);
    c.useDeviceVoice();
    expect(natural.plays).toHaveLength(0);
    expect(fallback.last).toMatchObject({ text: "Uno.", deviceLang: "tr" });
    expect(c.getState().usingFallbackVoice).toBe(true);
  });

  it("doesn't offer the device voice when the device has none for the language", () => {
    fallback.speaks = ["en"];
    c.load(ARTICLE, detected("tr"));
    expect(c.getState().deviceVoiceAvailable).toBe(false);
  });

  it("reads German with a Piper voice, telling the server which engine", () => {
    c.load(ARTICLE, detected("de"));
    c.play();
    expect(natural.last).toMatchObject({
      voiceId: "de_DE-kerstin-medium", lang: "de", deviceLang: "de-DE", engine: "piper",
    });
    c.load(ARTICLE, detected("es"));
    c.play();
    expect(natural.last).toMatchObject({ voiceId: "ef_dora", engine: "kokoro" });
  });

  it("uses the female French voice for a male preference, with a one-line notice", () => {
    c.load(ARTICLE, detected("en"));
    c.setVoice("am_michael"); // the user prefers men's voices
    c.load(ARTICLE, detected("fr"));
    c.play();
    expect(c.getState().voiceNotice).toBe("Only a female voice is available for French.");
    expect(natural.last).toMatchObject({ voiceId: "ff_siwis", lang: "fr", deviceLang: "fr-FR" });
    c.load(ARTICLE, detected("es"));
    expect(c.getState()).toMatchObject({ voiceId: "em_alex", voiceNotice: undefined }); // gender kept
  });

  it("remembers a voice per language", () => {
    c.load(ARTICLE, detected("es"));
    c.setVoice("em_santa");
    c.load(ARTICLE, detected("en"));
    expect(c.getState().voiceId).toBe("am_eric");
    c.load(ARTICLE, detected("es"));
    expect(c.getState().voiceId).toBe("em_santa");
  });

  const unsure = (lang: string) => detected(lang, { confidence: 50, source: "html", needsConfirm: true });

  it("a site choice is used when detection isn't sure, until Reset", async () => {
    c.load(ARTICLE, unsure("es"));
    c.setLanguage("pt");
    await settle();
    const next = await make("news.example");
    next.load(ARTICLE, unsure("es"));
    expect(next.getState().language).toMatchObject({ code: "pt", source: "user", savedForSite: true });
    const other = await make("elsewhere.example");
    other.load(ARTICLE, unsure("es"));
    expect(other.getState().language?.code).toBe("es");
    next.resetSiteLanguage();
    expect(next.getState().language).toMatchObject({ code: "es", source: "html", savedForSite: false });
    await settle();
    expect((await loadPrefs(["langByHost"])).langByHost).toEqual({});
  });

  it("a site choice never reads text that is clearly another language (Voix doesn't translate)", async () => {
    c.load(ARTICLE, unsure("en"));
    c.setLanguage("de"); // remembered for news.example
    await settle();
    const next = await make("news.example");
    next.load(ARTICLE, detected("en")); // an English article on the same site
    next.play();
    expect(next.getState().language).toMatchObject({ code: "en", source: "auto" });
    expect(natural.last).toMatchObject({ lang: "en", voiceId: "af_heart" });
    next.load(ARTICLE, detected("de")); // a German one still reads in German
    expect(next.getState().language).toMatchObject({ code: "de" });
  });

  it("picking another language for clearly English text warns first and sends nothing", async () => {
    c.load(ARTICLE, detected("en"));
    c.play();
    natural.fire("playing");
    const plays = natural.plays.length;
    c.setLanguage("de");
    expect(c.getState()).toMatchObject({
      languageConflict: { code: "de", name: "German", textName: "English" },
      language: { code: "en" },
    });
    expect(natural.plays).toHaveLength(plays); // no German request for English text
    c.cancelLanguageChoice();
    expect(c.getState()).toMatchObject({ languageConflict: undefined, languagePickerOpen: false, language: { code: "en" } });
    await settle();
    expect((await loadPrefs(["langByHost"])).langByHost).toEqual({});
  });

  it("\"use anyway\" applies to this text only and is never remembered for the site", async () => {
    c.load(ARTICLE, detected("en"));
    c.setLanguage("de");
    c.confirmLanguageChoice();
    c.play();
    expect(c.getState()).toMatchObject({ languageConflict: undefined, language: { code: "de", savedForSite: false } });
    expect(natural.last).toMatchObject({ lang: "de", engine: "piper" });
    await settle();
    expect((await loadPrefs(["langByHost"])).langByHost).toEqual({});
    c.load(ARTICLE, detected("en")); // the next article is read in its own language again
    expect(c.getState().language).toMatchObject({ code: "en", source: "auto" });
  });

  it("a language change while reading restarts from the start of the paragraph", () => {
    c.load(ARTICLE, detected("es"));
    c.play();
    natural.fire("playing");
    natural.fire("ended");
    natural.fire("ended");
    natural.fire("ended"); // now on s3, second sentence of paragraph 1
    expect(c.getState().currentIndex).toBe(3);
    const stops = natural.calls.filter((x) => x === "stop").length;
    c.setLanguage("it");
    expect(c.getState().currentIndex).toBe(3); // nothing changes until the user confirms
    c.confirmLanguageChoice();
    expect(natural.calls.filter((x) => x === "stop").length).toBeGreaterThan(stops); // queued audio dropped
    expect(c.getState().currentIndex).toBe(2);
    expect(natural.last).toMatchObject({ text: "Tres.", voiceId: "if_sara", lang: "it" });
  });

  it("a language change while paused restarts the paragraph on resume", () => {
    c.load(ARTICLE, detected("es"));
    c.jumpTo(1);
    natural.fire("playing");
    c.pause();
    c.setLanguage("fr");
    c.confirmLanguageChoice();
    expect(c.getState().currentIndex).toBe(0);
    c.play();
    expect(natural.last).toMatchObject({ text: "Uno.", voiceId: "ff_siwis" });
  });

  it("finds the start of a paragraph", () => {
    expect(paragraphStart(ARTICLE, 3)).toBe(2);
    expect(paragraphStart(ARTICLE, 4)).toBe(4);
    expect(paragraphStart([{ id: "x", text: "No paragraphs." }], 0)).toBe(0);
  });

  it("language_not_supported from the server: shows the unsupported state and reloads the registry", async () => {
    c.load(ARTICLE, detected("es"));
    c.play();
    natural.fail("language not supported: es", "language_not_supported");
    expect(c.getState()).toMatchObject({ status: "idle", usingFallbackVoice: false, language: { code: "es", supported: false } });
    expect(fallback.plays).toHaveLength(0);
    expect(refreshRegistry).toHaveBeenCalled();
    await settle();
    expect(c.getState().language?.supported).toBe(false); // refused for this session
  });

  it("voice_language_mismatch: reloads the registry and retries the sentence once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    c.load(ARTICLE, detected("es"));
    c.play();
    natural.fail("voice does not belong", "voice_language_mismatch");
    expect(warn).toHaveBeenCalled();
    await settle();
    expect(refreshRegistry).toHaveBeenCalledTimes(1);
    expect(natural.plays).toHaveLength(2);
    expect(natural.last).toMatchObject({ text: "Uno.", voiceId: "ef_dora", lang: "es" });
    natural.fail("voice does not belong", "voice_language_mismatch");
    expect(c.getState()).toMatchObject({ status: "error", error: "Voix couldn't find a voice for Spanish." });
    expect(fallback.plays).toHaveLength(0);
    warn.mockRestore();
  });

  it("text_empty_or_too_long: skips the sentence instead of stopping", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    c.load(ARTICLE, detected("es"));
    c.play();
    natural.fail("text must be 1 to 1000 characters", "text_empty_or_too_long");
    expect(natural.last.text).toBe("Dos.");
    expect(c.getState().usingFallbackVoice).toBe(false);
    warn.mockRestore();
  });

  it("engine_unavailable: switches to the device voice for that language", () => {
    c.load(ARTICLE, detected("it"));
    c.play();
    natural.fail("timed out", "engine_unavailable");
    expect(c.getState().usingFallbackVoice).toBe(true);
    expect(fallback.last).toMatchObject({ text: "Uno.", deviceLang: "it-IT" });
  });

  it("engine_unavailable without a device voice for the language: stops with a clear message", () => {
    fallback.speaks = ["en"];
    c.load(ARTICLE, detected("it"));
    c.play();
    natural.fail("timed out", "engine_unavailable");
    expect(fallback.plays).toHaveLength(0);
    expect(c.getState()).toMatchObject({
      status: "error", error: "Natural voices are unavailable right now, and this device has no Italian voice.",
    });
  });

  it("with the feature flag off, reads everything in English as before", () => {
    c.setMultilingual(false);
    c.load(ARTICLE, detected("es"));
    c.play();
    expect(c.getState().language).toMatchObject({ code: "en", supported: true });
    expect(natural.last).toMatchObject({ voiceId: "af_heart", lang: "en" });
  });

  it("a streamed document waits for its detection, then reads in that language", () => {
    c.prepare("Opening PDF…");
    expect(c.getState().language).toBeNull();
    c.applyDetection(detected("fr"));
    c.append(ARTICLE.slice(0, 2));
    expect(natural.last).toMatchObject({ text: "Uno.", voiceId: "ff_siwis", lang: "fr" });
  });

  it("a streamed document with an uncertain language asks before reading", () => {
    c.prepare("Opening PDF…");
    c.applyDetection(detected("es", { needsConfirm: true }));
    c.append(ARTICLE.slice(0, 2));
    expect(c.getState()).toMatchObject({ status: "idle", languagePickerOpen: true });
    expect(natural.plays).toHaveLength(0);
    c.setLanguage("es");
    expect(natural.last).toMatchObject({ text: "Uno.", lang: "es" });
  });

  it("migrates the saved English voice and its gender from older versions", async () => {
    localStorage.setItem("voix:voiceId", JSON.stringify("bm_george"));
    const migrated = await make();
    migrated.load(ARTICLE, detected("en"));
    expect(migrated.getState().voiceId).toBe("bm_george");
    migrated.load(ARTICLE, detected("es"));
    expect(migrated.getState().voiceId).toBe("em_alex"); // prefers men's voices, like George
  });
});

/** Stands in for Chrome's translator: "DE: text". */
class FakeTranslator implements TextTranslator {
  missing = false; // an older Chrome: no translator at all
  unsupported = new Set<string>(["ca"]); // Chrome can't translate into Catalan
  fail: TranslationError | null = null;
  prepared: string[] = [];
  translated: string[] = [];
  problem(from: string, to: string): TranslationProblem | null {
    if (this.missing) return "no-translator";
    return from === to || this.unsupported.has(to) ? "pair-unsupported" : null;
  }
  async prepare(from: string, to: string) {
    this.prepared.push(`${from}>${to}`);
  }
  async translate(text: string, _from: string, to: string) {
    if (this.fail) throw this.fail;
    this.translated.push(text);
    return `${to.toUpperCase()}: ${text}`;
  }
}

describe("VoixReaderController translation", () => {
  let natural: FakeEngine;
  let translator: FakeTranslator;
  let c: VoixReaderController;
  const ARTICLE = [
    { id: "s0", text: "One.", para: 0 }, { id: "s1", text: "Two.", para: 0 },
    { id: "s2", text: "Three.", para: 1 }, { id: "s3", text: "Four.", para: 1 },
  ];
  const detected = (lang: string): Detection =>
    ({ lang, confidence: 95, source: "text", mixed: false, needsConfirm: false });
  const settle = () => new Promise((r) => setTimeout(r, 0));

  async function make(site = "news.example") {
    const ctl = new VoixReaderController(natural, new FakeEngine(), { site, translator });
    await ctl.loadPrefs();
    ctl.setMultilingual(true);
    return ctl;
  }

  beforeEach(async () => {
    natural = new FakeEngine();
    translator = new FakeTranslator();
    c = await make();
  });

  it("picking German for an English article translates it and reads it in German", async () => {
    c.load(ARTICLE, detected("en"));
    c.play();
    natural.fire("playing");
    c.setLanguage("de");
    expect(c.getState()).toMatchObject({
      languageConflict: undefined,
      language: { code: "de", translatedFrom: { code: "en", name: "English" }, savedForSite: true },
    });
    expect(translator.prepared).toContain("en>de"); // started inside the click
    await settle();
    expect(natural.last).toMatchObject({
      text: "DE: One.", prefetch: ["DE: Two.", "DE: Three."], lang: "de", voiceId: "de_DE-kerstin-medium", engine: "piper",
    });
    expect(c.getState().translated).toEqual({ lang: "de", texts: ["DE: One.", "DE: Two.", "DE: Three.", "DE: Four."] });
    expect((await loadPrefs(["langByHost"])).langByHost).toEqual({ "news.example": "de" });
  });

  it("the next English article on that site is translated too; a German one is read as it is", async () => {
    c.load(ARTICLE, detected("en"));
    c.setLanguage("de");
    await settle();
    const next = await make();
    next.load(ARTICLE, detected("en"));
    expect(next.getState().language).toMatchObject({ code: "de", translatedFrom: { code: "en" } });
    next.load(ARTICLE, detected("de"));
    next.play();
    expect(next.getState().language?.translatedFrom).toBeUndefined();
    expect(natural.last).toMatchObject({ text: "One.", lang: "de" }); // no translation needed
  });

  it("a language Chrome can't translate into: warns, explaining why, and sends nothing", () => {
    c.load(ARTICLE, detected("en"));
    c.play();
    const plays = natural.plays.length;
    c.setLanguage("ca");
    expect(c.getState().languageConflict).toMatchObject({ code: "ca", textName: "English", reason: "pair-unsupported" });
    expect(natural.plays).toHaveLength(plays);
  });

  it("an older Chrome without a translator: warns that translation needs a newer Chrome", () => {
    translator.missing = true;
    c.load(ARTICLE, detected("en"));
    c.setLanguage("de");
    expect(c.getState().languageConflict).toMatchObject({ code: "de", reason: "no-translator" });
  });

  it("a download that needs a click: stops with a note, then Play gets it ready and reads", async () => {
    c.load(ARTICLE, detected("en"));
    translator.fail = new TranslationError("needs a click", "needs-click");
    c.setLanguage("de");
    c.play();
    await settle();
    expect(c.getState()).toMatchObject({
      status: "idle", translationNotice: "Press Play to get German ready. Chrome downloads it once.",
    });
    expect(natural.plays).toHaveLength(0);
    translator.fail = null;
    c.play();
    await settle();
    expect(c.getState().translationNotice).toBeUndefined();
    expect(natural.last).toMatchObject({ text: "DE: One.", lang: "de" });
  });

  it("a pair that fails to translate: reads the text in its own language, and says so", async () => {
    c.load(ARTICLE, detected("en"));
    translator.fail = new TranslationError("refused", "unsupported");
    c.setLanguage("de");
    c.play();
    await settle();
    expect(c.getState()).toMatchObject({
      language: { code: "en" },
      translationNotice: "This browser couldn't translate English to German, so Voix reads it in English.",
    });
    expect(natural.last).toMatchObject({ text: "One.", lang: "en", voiceId: "af_heart" });
  });

  it("Voix can't read Turkish, but offers to translate it into English", async () => {
    c.load(ARTICLE, detected("tr"));
    expect(c.getState()).toMatchObject({ language: { code: "tr", supported: false }, translateOffer: { code: "en", name: "English" } });
    c.setLanguage("en");
    c.play();
    await settle();
    expect(c.getState().language).toMatchObject({ code: "en", translatedFrom: { code: "tr", name: "Turkish" } });
    expect(natural.last).toMatchObject({ text: "EN: One.", lang: "en" });
  });

  it("translates even when detection isn't sure: short pieces of English text, German picked", async () => {
    // What a page of short headings and links gives the detector: a guess, not a certainty.
    const unsure: Detection = { lang: "en", confidence: 50, source: "html", mixed: false, needsConfirm: true };
    c.load(ARTICLE, unsure);
    c.setLanguage("de");
    expect(c.getState().language).toMatchObject({ code: "de", translatedFrom: { code: "en" } });
    c.play();
    await settle();
    expect(natural.last).toMatchObject({ text: "DE: One.", lang: "de" }); // never English words to a German voice
    const next = await make(); // and the remembered choice translates the site's next page too
    next.load(ARTICLE, unsure);
    expect(next.getState().language).toMatchObject({ code: "de", translatedFrom: { code: "en" } });
  });

  it("translations of a previous text are never shown for the next one", async () => {
    c.load(ARTICLE, detected("en"));
    c.setLanguage("de");
    c.play();
    await settle();
    c.load([{ id: "s0", text: "Hallo.", para: 0 }], detected("de"));
    expect(c.getState().translated).toBeUndefined();
  });
});
