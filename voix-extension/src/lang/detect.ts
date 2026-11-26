// Detects the language of the text Voix is about to read. Runs on the extracted article
// text (never the raw page: menus, ads and comments pollute the result), using the
// browser's built-in detector (chrome.i18n.detectLanguage: free, offline), with the
// page's own declaration (<html lang>, og:locale) as a weaker hint.

import { browser } from "wxt/browser";

export type DetectionSource = "text" | "text_and_html" | "html" | "unknown";

export interface Detection {
  /** Normalised code ("es", "zh-TW"), or null when nothing could be determined. */
  lang: string | null;
  /** 0 to 100. */
  confidence: number;
  source: DetectionSource;
  /** A second language makes up 30% or more of the text. */
  mixed: boolean;
  /** Not sure enough: the widget must ask the user before reading. */
  needsConfirm: boolean;
}

/** chrome.i18n.detectLanguage's result. */
export interface TextLanguages {
  isReliable: boolean;
  languages: { language: string; percentage: number }[];
}

export const MIN_CHARS = 200;
export const MIN_CONFIDENCE = 70;
const MIN_AGREEING = 40;
const MIXED_SHARE = 30;
const HEAD_CHARS = 1500;
const MIDDLE_CHARS = 500;

/**
 * What to run the detector on: the first 1,500 characters of the body plus 500 from the middle,
 * so one quoted foreign sentence at the top can't decide the language. The title is skipped.
 */
export function buildSample(texts: string[]): { sample: string; charCount: number } {
  // A headline rarely ends like a sentence; drop it when there is body text after it.
  const hasTitle = texts.length > 1 && !/[.!?…。！？:;"'”’»)\]]$/u.test(texts[0]!.trim());
  const body = (hasTitle ? texts.slice(1) : texts).join(" ").replace(/\s+/g, " ").trim();
  if (body.length <= HEAD_CHARS + MIDDLE_CHARS) return { sample: body, charCount: body.length };
  const mid = Math.floor(body.length / 2);
  const middle = body.slice(Math.max(HEAD_CHARS, mid - MIDDLE_CHARS / 2), mid + MIDDLE_CHARS / 2);
  return { sample: `${body.slice(0, HEAD_CHARS)} ${middle}`, charCount: body.length };
}

/**
 * A language tag reduced to what the registry needs: the primary subtag ("pt-BR" -> "pt"),
 * except Chinese, which keeps its region or script ("zh-TW", "zh-Hant") for the registry's aliases.
 */
export function normaliseTag(tag: string | null | undefined): string | null {
  const t = tag?.trim().replace(/_/g, "-");
  if (!t || !/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(t)) return null;
  const [first, sub] = t.split("-");
  const primary = first!.toLowerCase();
  if (primary === "und" || primary === "xx") return null;
  if (primary !== "zh" || !sub) return primary;
  return sub.length === 4 ? `zh-${sub[0]!.toUpperCase()}${sub.slice(1).toLowerCase()}` : `zh-${sub.toUpperCase()}`;
}

const primaryOf = (tag: string | null) => tag?.split("-")[0] ?? null;

/** The page's own declaration: <html lang>, else the og:locale meta tag. */
export function htmlLanguage(doc: Document = document): string | null {
  const og = doc.querySelector<HTMLMetaElement>("meta[property='og:locale']")?.content;
  return normaliseTag(doc.documentElement.lang) ?? normaliseTag(og);
}

/**
 * Combine the text detector with the page's declaration. The text wins: many sites say
 * lang="en" whatever they publish. userLangs: the browser's languages (navigator.languages).
 * When Voix would ask, but the language is one the user reads anyway (a short English selection
 * for an English-speaking user), it doesn't: the chip still lets them change it.
 */
export function decide(
  text: TextLanguages | null, htmlLang: string | null, charCount: number, userLangs: readonly string[] = [],
): Detection {
  const d = decideFromSignals(text, htmlLang, charCount);
  const own = new Set(userLangs.map((l) => primaryOf(normaliseTag(l))).filter(Boolean));
  return d.needsConfirm && d.lang && own.has(primaryOf(d.lang)) ? { ...d, needsConfirm: false } : d;
}

function decideFromSignals(text: TextLanguages | null, htmlLang: string | null, charCount: number): Detection {
  const langs = (text?.languages ?? []).filter((l) => normaliseTag(l.language));
  const top = langs[0];
  const second = langs[1];
  const topLang = top ? normaliseTag(top.language) : null;
  const mixed = !!second && second.percentage >= MIXED_SHARE;
  const enough = charCount >= MIN_CHARS;
  const sure = !!top && !!text?.isReliable && top.percentage >= MIN_CONFIDENCE;

  if (sure && enough) {
    return { lang: topLang, confidence: top!.percentage, source: "text", mixed, needsConfirm: false };
  }
  if (enough && htmlLang && top && primaryOf(htmlLang) === primaryOf(topLang) && top.percentage >= MIN_AGREEING) {
    return { lang: htmlLang, confidence: MIN_CONFIDENCE, source: "text_and_html", mixed, needsConfirm: false };
  }
  // Too little text to be certain, but the detector has a clear favourite: suggest it, and ask.
  if (sure) return { lang: topLang, confidence: top!.percentage, source: "text", mixed, needsConfirm: true };
  if (htmlLang) return { lang: htmlLang, confidence: 50, source: "html", mixed, needsConfirm: true };
  return { lang: topLang, confidence: top?.percentage ?? 0, source: "unknown", mixed, needsConfirm: true };
}

/** The text itself clearly says which language it is (not just the page's declaration, not a guess). */
export function isConfident(d: Detection | null | undefined): d is Detection & { lang: string } {
  return !!d?.lang && d.confidence >= MIN_CONFIDENCE && (d.source === "text" || d.source === "text_and_html");
}

/** chrome.i18n.detectLanguage, or the same call in the service worker if this context lacks it. */
export async function detectTextLanguages(sample: string): Promise<TextLanguages | null> {
  if (!sample) return null;
  const i18n = (browser as { i18n?: { detectLanguage?: (t: string) => Promise<TextLanguages> } }).i18n;
  if (i18n?.detectLanguage) {
    try {
      return await i18n.detectLanguage(sample);
    } catch {
      // fall through to the service worker
    }
  }
  const viaBackground = await browser.runtime
    .sendMessage({ target: "background", detectLanguage: sample })
    .catch(() => null);
  return (viaBackground as TextLanguages | null) ?? null;
}

/** The languages the user's browser is set to, most preferred first. */
export function browserLanguages(): string[] {
  if (typeof navigator === "undefined") return [];
  return [...(navigator.languages ?? []), navigator.language].filter(Boolean);
}

/** Detect the language of the texts about to be read (sentences or paragraphs, in reading order). */
export async function detectLanguage(texts: string[], doc: Document = document): Promise<Detection> {
  const { sample, charCount } = buildSample(texts);
  return decide(await detectTextLanguages(sample), htmlLanguage(doc), charCount, browserLanguages());
}
