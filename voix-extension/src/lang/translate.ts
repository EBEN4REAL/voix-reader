// Translation with Chrome's built-in, on-device translator (Chrome 138+ on desktop): free,
// and the text never leaves the computer. Used when the user picks a language the article
// isn't written in: each sentence is translated just before it is read.
// https://developer.chrome.com/docs/ai/translator-api

/** Languages Chrome's translator supports (its documented list; checked against Chrome 159). */
const CHROME_LANGUAGES = [
  "ar", "bg", "bn", "cs", "da", "de", "el", "en", "es", "fi", "fr", "he", "hi", "hr", "hu", "id", "it", "ja",
  "kn", "ko", "lt", "mr", "nl", "no", "pl", "pt", "ro", "ru", "sk", "sl", "sv", "ta", "te", "th", "tr", "uk",
  "vi", "zh", "zh-Hant",
];
const BY_LOWER = new Map(CHROME_LANGUAGES.map((c) => [c.toLowerCase(), c]));
// Detector and registry codes Chrome knows by another name.
const ALIASES: Record<string, string> = {
  iw: "he", nb: "no", nn: "no", "zh-cn": "zh", "zh-hans": "zh", "zh-tw": "zh-Hant", "zh-hk": "zh-Hant",
};

/** Chrome's code for a language tag ("pt-BR" -> "pt", "zh-TW" -> "zh-Hant"), or null if it can't translate it. */
export function translatorCode(tag: string): string | null {
  const t = tag.toLowerCase().replace(/_/g, "-");
  for (const candidate of [t, ALIASES[t], t.split("-")[0]!, ALIASES[t.split("-")[0]!]]) {
    if (candidate && BY_LOWER.has(candidate.toLowerCase())) return BY_LOWER.get(candidate.toLowerCase())!;
  }
  return null;
}

/** Why a pair can't be translated here: no translator in this browser, or not this pair. */
export type TranslationProblem = "no-translator" | "pair-unsupported";

export class TranslationError extends Error {
  constructor(message: string, readonly kind: "needs-click" | "unsupported" | "failed") {
    super(message);
  }
}

export interface TextTranslator {
  /** Null when this browser can translate from -> to; otherwise why not. */
  problem(from: string, to: string): TranslationProblem | null;
  /** Get the pair ready (the first time, Chrome downloads its language pack). Call it from a click. */
  prepare(from: string, to: string, onProgress?: (fraction: number) => void): Promise<void>;
  translate(text: string, from: string, to: string): Promise<string>;
}

interface ChromeTranslator {
  translate(text: string): Promise<string>;
}

interface ChromeTranslatorApi {
  create(options: {
    sourceLanguage: string;
    targetLanguage: string;
    monitor?(m: EventTarget): void;
  }): Promise<ChromeTranslator>;
}

const CACHE_LIMIT = 2000;

/** Chrome's built-in translator: one translator per language pair, translations cached. */
export class ChromeTextTranslator implements TextTranslator {
  private translators = new Map<string, Promise<ChromeTranslator>>();
  private failed = new Set<string>();
  private cache = new Map<string, string>();

  constructor(
    private api: ChromeTranslatorApi | undefined = (globalThis as { Translator?: ChromeTranslatorApi }).Translator,
  ) {}

  problem(from: string, to: string): TranslationProblem | null {
    if (!this.api) return "no-translator";
    const source = translatorCode(from);
    const target = translatorCode(to);
    if (!source || !target || source === target || this.failed.has(`${source}|${target}`)) return "pair-unsupported";
    return null;
  }

  async prepare(from: string, to: string, onProgress?: (fraction: number) => void): Promise<void> {
    await this.translator(from, to, onProgress);
  }

  async translate(text: string, from: string, to: string): Promise<string> {
    const key = `${from}|${to}|${text}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const translator = await this.translator(from, to);
    let out: string;
    try {
      out = (await translator.translate(text)).trim() || text;
    } catch (e) {
      throw new TranslationError((e as Error)?.message || "Translation failed", "failed");
    }
    this.cache.set(key, out);
    if (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
    return out;
  }

  private translator(from: string, to: string, onProgress?: (fraction: number) => void): Promise<ChromeTranslator> {
    if (this.problem(from, to)) {
      return Promise.reject(new TranslationError(`This browser can't translate ${from} to ${to}`, "unsupported"));
    }
    const sourceLanguage = translatorCode(from)!;
    const targetLanguage = translatorCode(to)!;
    const pair = `${sourceLanguage}|${targetLanguage}`;
    let entry = this.translators.get(pair);
    if (!entry) {
      entry = this.api!.create({
        sourceLanguage,
        targetLanguage,
        monitor(m) {
          m.addEventListener("downloadprogress", (e) => onProgress?.((e as ProgressEvent).loaded));
        },
      }).catch((e: Error) => {
        this.translators.delete(pair);
        // Downloading a language pack needs a click; nothing is wrong with the pair.
        if (e?.name === "NotAllowedError") throw new TranslationError("A click is needed to get this language ready", "needs-click");
        this.failed.add(pair);
        throw new TranslationError(e?.message || "This browser can't translate these languages", "unsupported");
      });
      this.translators.set(pair, entry);
    }
    return entry;
  }
}
