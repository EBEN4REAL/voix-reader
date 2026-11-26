import { describe, expect, it } from "vitest";
import { ChromeTextTranslator, TranslationError, translatorCode } from "../src/lang/translate";

type Options = { sourceLanguage: string; targetLanguage: string; monitor?(m: EventTarget): void };

/** Stands in for Chrome's Translator API. */
class FakeChrome {
  creates: Options[] = [];
  translations = 0;
  fail: "" | "NotAllowedError" | "NotSupportedError" = "";
  async create(options: Options) {
    this.creates.push(options);
    if (this.fail) throw Object.assign(new Error(this.fail), { name: this.fail });
    const monitor = new EventTarget();
    options.monitor?.(monitor);
    const progress = new Event("downloadprogress");
    Object.defineProperty(progress, "loaded", { value: 0.5 });
    monitor.dispatchEvent(progress);
    return {
      translate: async (text: string) => {
        this.translations++;
        return ` [${options.targetLanguage}] ${text} `;
      },
    };
  }
}

describe("translatorCode", () => {
  it.each([
    ["en", "en"], ["pt-BR", "pt"], ["de-AT", "de"], ["zh", "zh"], ["zh-TW", "zh-Hant"], ["zh-Hant", "zh-Hant"],
    ["iw", "he"], ["nb", "no"], ["no", "no"], ["fa", null], ["ur", null], ["ca", null], ["cy", null],
  ])("%s -> %s", (tag, code) => {
    expect(translatorCode(tag)).toBe(code);
  });
});

describe("ChromeTextTranslator", () => {
  it("says why it can't translate: no translator (older Chrome), or not this pair", () => {
    expect(new ChromeTextTranslator(undefined).problem("en", "de")).toBe("no-translator");
    const t = new ChromeTextTranslator(new FakeChrome());
    expect(t.problem("en", "de")).toBeNull();
    expect(t.problem("tr", "en")).toBeNull(); // Voix can't read Turkish, but Chrome translates it
    expect(t.problem("en", "fa")).toBe("pair-unsupported");
    expect(t.problem("en", "en")).toBe("pair-unsupported");
  });

  it("creates one translator per pair, reports download progress, and caches translations", async () => {
    const chrome = new FakeChrome();
    const t = new ChromeTextTranslator(chrome);
    const progress: number[] = [];
    await t.prepare("en", "de", (f) => progress.push(f));
    expect(progress).toEqual([0.5]);
    expect(await t.translate("Hello.", "en", "de")).toBe("[de] Hello.");
    expect(await t.translate("Hello.", "en", "de")).toBe("[de] Hello.");
    expect(await t.translate("Good night.", "en", "de")).toBe("[de] Good night.");
    expect(chrome.creates.map((c) => `${c.sourceLanguage}>${c.targetLanguage}`)).toEqual(["en>de"]);
    expect(chrome.translations).toBe(2); // the repeat came from the cache
    await t.translate("Hello.", "pt-BR", "zh-TW");
    expect(chrome.creates.at(-1)).toMatchObject({ sourceLanguage: "pt", targetLanguage: "zh-Hant" });
  });

  it("a download that needs a click can be retried; nothing is wrong with the pair", async () => {
    const chrome = new FakeChrome();
    chrome.fail = "NotAllowedError";
    const t = new ChromeTextTranslator(chrome);
    await expect(t.translate("Hello.", "en", "de")).rejects.toMatchObject({ kind: "needs-click" });
    expect(t.problem("en", "de")).toBeNull();
    chrome.fail = "";
    expect(await t.translate("Hello.", "en", "de")).toBe("[de] Hello.");
  });

  it("a pair Chrome refuses is not offered again", async () => {
    const chrome = new FakeChrome();
    chrome.fail = "NotSupportedError";
    const t = new ChromeTextTranslator(chrome);
    const error = await t.translate("Hello.", "en", "de").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TranslationError);
    expect(error).toMatchObject({ kind: "unsupported" });
    expect(t.problem("en", "de")).toBe("pair-unsupported");
  });
});
