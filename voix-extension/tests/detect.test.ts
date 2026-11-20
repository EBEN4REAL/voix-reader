import { afterEach, describe, expect, it, vi } from "vitest";

const browserMock = vi.hoisted(() => ({
  i18n: undefined as undefined | { detectLanguage: ReturnType<typeof vi.fn> },
  runtime: { sendMessage: vi.fn() },
}));
vi.mock("wxt/browser", () => ({ browser: browserMock }));

import {
  buildSample, decide, detectLanguage, htmlLanguage, normaliseTag, type TextLanguages,
} from "../src/lang/detect";
import { BUNDLED_REGISTRY as REG } from "../src/lang/registry";
import { resolveLanguage } from "../src/lang/resolve";

const sure = (language: string, percentage = 97, second?: [string, number]): TextLanguages => ({
  isReliable: true,
  languages: [{ language, percentage }, ...(second ? [{ language: second[0], percentage: second[1] }] : [])],
});
const unsure = (language: string, percentage: number): TextLanguages => ({
  isReliable: false, languages: [{ language, percentage }],
});

describe("buildSample", () => {
  it("skips the title and samples the start and the middle of long text", () => {
    const body = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} goes here.`);
    const { sample, charCount } = buildSample(["A Headline Without a Full Stop", ...body]);
    expect(sample).not.toContain("Headline");
    expect(sample.startsWith("Sentence number 0")).toBe(true);
    expect(sample.length).toBeLessThanOrEqual(1500 + 1 + 500);
    expect(sample).toContain("Sentence number 30"); // from the middle
    expect(charCount).toBe(body.join(" ").length);
  });

  it("keeps a first sentence that reads like a sentence", () => {
    expect(buildSample(["Hola a todos.", "Buenos días."]).sample).toBe("Hola a todos. Buenos días.");
  });
});

describe("normaliseTag", () => {
  it.each([
    ["pt-BR", "pt"], ["en_US", "en"], ["es", "es"], ["zh-cn", "zh-CN"], ["zh_hant", "zh-Hant"], ["zh", "zh"],
    ["und", null], ["", null], [null, null], ["not a tag!", null],
  ])("%s -> %s", (tag, expected) => {
    expect(normaliseTag(tag)).toBe(expected);
  });
});

describe("htmlLanguage", () => {
  afterEach(() => {
    document.documentElement.lang = "";
    document.head.innerHTML = "";
  });

  it("reads <html lang>, then og:locale", () => {
    document.head.innerHTML = '<meta property="og:locale" content="es_MX">';
    expect(htmlLanguage()).toBe("es");
    document.documentElement.lang = "fr-FR";
    expect(htmlLanguage()).toBe("fr");
  });
});

describe("decide", () => {
  it("trusts the text over the page: a Spanish article with lang=\"en\" is Spanish", () => {
    expect(decide(sure("es"), "en", 3000)).toEqual({
      lang: "es", confidence: 97, source: "text", mixed: false, needsConfirm: false,
    });
  });

  it("uses the page's declaration when it agrees with a weaker text result", () => {
    expect(decide(unsure("pt", 55), "pt", 3000)).toMatchObject({ lang: "pt", confidence: 70, source: "text_and_html", needsConfirm: false });
  });

  it("asks when confidence is below 70%", () => {
    expect(decide(unsure("es", 60), null, 3000)).toMatchObject({ lang: "es", source: "unknown", needsConfirm: true });
    expect(decide(unsure("es", 30), "it", 3000)).toMatchObject({ lang: "it", source: "html", needsConfirm: true });
  });

  it("asks when there are fewer than 200 characters, suggesting the detector's guess", () => {
    expect(decide(sure("es"), "en", 150)).toMatchObject({ lang: "es", needsConfirm: true });
    expect(decide(unsure("pt", 55), "pt", 150)).toMatchObject({ lang: "pt", source: "html", needsConfirm: true });
  });

  it("doesn't ask about the user's own language, even for short or uncertain text", () => {
    // A two-sentence English selection, browser set to English: just read it.
    expect(decide(sure("en"), "en", 150, ["en-US", "en"])).toMatchObject({ lang: "en", needsConfirm: false });
    expect(decide(unsure("en", 55), null, 3000, ["en-GB"])).toMatchObject({ lang: "en", needsConfirm: false });
    expect(decide(unsure("fr", 30), "fr", 3000, ["en-US", "fr-CA"])).toMatchObject({ lang: "fr", needsConfirm: false });
  });

  it("still asks about other languages, and when it has no guess at all", () => {
    expect(decide(sure("es"), "en", 150, ["en-US"])).toMatchObject({ lang: "es", needsConfirm: true });
    expect(decide(unsure("de", 50), null, 3000, ["en-US"])).toMatchObject({ lang: "de", needsConfirm: true });
    expect(decide(null, null, 0, ["en-US"])).toMatchObject({ lang: null, needsConfirm: true });
  });

  it("flags mixed-language text but reads it in the main language", () => {
    expect(decide(sure("en", 70, ["es", 30]), "en", 3000)).toMatchObject({ lang: "en", mixed: true, needsConfirm: false });
    expect(decide(sure("en", 80, ["es", 20]), "en", 3000)).toMatchObject({ mixed: false });
  });

  it("knows nothing without text or a page declaration", () => {
    expect(decide(null, null, 0)).toEqual({ lang: null, confidence: 0, source: "unknown", mixed: false, needsConfirm: true });
    expect(decide({ isReliable: false, languages: [{ language: "und", percentage: 100 }] }, null, 500).lang).toBeNull();
  });

  it("keeps Chinese script and region for the registry", () => {
    expect(decide(sure("zh-Hant"), null, 3000).lang).toBe("zh-Hant");
  });

  it("marks Turkish as unsupported: Voix never reads it", () => {
    const language = resolveLanguage({ registry: REG, multilingual: true, detection: decide(sure("tr"), "tr", 3000) });
    expect(language).toMatchObject({ code: "tr", name: "Turkish", supported: false });
  });

  it("reads German, now that Piper speaks it", () => {
    const language = resolveLanguage({ registry: REG, multilingual: true, detection: decide(sure("de"), "en", 3000) });
    expect(language).toMatchObject({ code: "de", name: "German", supported: true });
  });

  it("treats Yoruba and other unlisted languages as unsupported", () => {
    const language = resolveLanguage({ registry: REG, multilingual: true, detection: decide(sure("yo", 80), null, 3000) });
    expect(language).toMatchObject({ name: "Yoruba", supported: false });
  });
});

describe("detectLanguage", () => {
  afterEach(() => {
    browserMock.i18n = undefined;
    browserMock.runtime.sendMessage.mockReset();
  });

  const SPANISH = Array.from({ length: 10 }, () => "El gobierno anunció hoy nuevas medidas para la economía del país.");

  it("uses chrome.i18n.detectLanguage on the sample", async () => {
    browserMock.i18n = { detectLanguage: vi.fn().mockResolvedValue(sure("es")) };
    const d = await detectLanguage(SPANISH);
    expect(browserMock.i18n.detectLanguage).toHaveBeenCalledWith(SPANISH.join(" "));
    expect(d).toMatchObject({ lang: "es", needsConfirm: false });
    expect(browserMock.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("asks the service worker when the API isn't available here", async () => {
    browserMock.runtime.sendMessage.mockResolvedValue(sure("it"));
    const d = await detectLanguage(SPANISH);
    expect(browserMock.runtime.sendMessage).toHaveBeenCalledWith({ target: "background", detectLanguage: SPANISH.join(" ") });
    expect(d.lang).toBe("it");
  });

  it("passes the browser's languages: a short English text for an English browser doesn't ask", async () => {
    browserMock.i18n = { detectLanguage: vi.fn().mockResolvedValue(sure("en")) };
    expect(navigator.languages).toContain("en-US"); // jsdom
    expect(await detectLanguage(["Read this sentence."])).toMatchObject({ lang: "en", needsConfirm: false });
    browserMock.i18n = { detectLanguage: vi.fn().mockResolvedValue(sure("de")) };
    expect(await detectLanguage(["Lies diesen Satz."])).toMatchObject({ lang: "de", needsConfirm: true });
  });

  it("falls back to the page's declaration when detection fails", async () => {
    browserMock.runtime.sendMessage.mockRejectedValue(new Error("no worker"));
    document.documentElement.lang = "fr";
    expect(await detectLanguage(SPANISH)).toMatchObject({ lang: "fr", source: "html", needsConfirm: true });
    document.documentElement.lang = "";
  });
});
