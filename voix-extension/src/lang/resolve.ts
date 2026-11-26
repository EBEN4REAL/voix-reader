// Which language to read in, and with which voice. Pure functions shared by the real and
// mock controllers.

import type { LanguageOption, ReaderState, ReadingLanguage } from "../controller/types";
import { isConfident, type Detection } from "./detect";
import {
  DEFAULT_LANGUAGE, findLanguage, isReadable, languageName, pickVoice, voicesFor, type Gender, type Registry,
} from "./registry";

/** Languages offered in the picker, each shown in its own language, in alphabetical order of that name. */
export function languageOptions(registry: Registry): LanguageOption[] {
  return registry.languages
    .filter(isReadable)
    .map((l) => ({ code: l.code, name: l.name, nativeName: l.nativeName, beta: l.beta }))
    .sort((a, b) => a.nativeName.localeCompare(b.nativeName, "en"));
}

export interface LanguageInputs {
  registry: Registry;
  /** Feature flag: when off, every article is read in English as before. */
  multilingual: boolean;
  detection: Detection | null;
  /**
   * The language the user chose for this website. Used when detection isn't sure (or agrees);
   * never over text that clearly is another language: Voix doesn't translate.
   */
  siteChoice?: string;
  /** Chosen for this text only, after Voix warned it is in another language ("use anyway"). */
  articleChoice?: string;
  /** Whether the text can be translated from one language into another here (Chrome's translator). */
  canTranslate?: (from: string, to: string) => boolean;
  /** Languages the server refused this session (language_not_supported). */
  refused?: ReadonlySet<string>;
}

/** The reading language, or null while it isn't known yet (Play stays disabled). */
/** Registry code for a language tag, or its primary subtag when Voix doesn't have it ("de", "tr"). */
const codeOf = (tag: string, registry: Registry) => findLanguage(tag, registry)?.code ?? tag.toLowerCase().split("-")[0]!;

/**
 * The text clearly is in another language than the one chosen: reading it with that voice would
 * only give the words a foreign accent. Returns the text's language, or null when there's no conflict.
 */
export function languageConflict(detection: Detection | null, code: string, registry: Registry): string | null {
  if (!isConfident(detection)) return null;
  return codeOf(detection.lang, registry) === codeOf(code, registry) ? null : codeOf(detection.lang, registry);
}

/**
 * The text's language as best known, even when detection isn't sure (a page of short headings),
 * when it isn't the chosen one: what to translate from. Null when it is the same or unknown.
 */
export function textLanguageGuess(detection: Detection | null, code: string, registry: Registry): string | null {
  if (!detection?.lang) return null;
  const guess = codeOf(detection.lang, registry);
  return guess === codeOf(code, registry) ? null : guess;
}

export function resolveLanguage(
  { registry, multilingual, detection, siteChoice, articleChoice, refused, canTranslate }: LanguageInputs,
): ReadingLanguage | null {
  const make = (
    code: string, source: ReadingLanguage["source"], confidence: number,
    mixed: boolean, needsConfirm: boolean, savedForSite: boolean,
  ): ReadingLanguage => {
    const entry = findLanguage(code, registry);
    return {
      code: entry?.code ?? code,
      name: entry?.name ?? languageName(code, registry),
      source,
      confidence,
      mixed,
      needsConfirm,
      supported: isReadable(entry) && !refused?.has(entry.code),
      beta: entry?.beta ?? false,
      savedForSite,
    };
  };

  if (!multilingual) return make(DEFAULT_LANGUAGE, "auto", 100, false, false, false);
  const forArticle = findLanguage(articleChoice, registry);
  if (isReadable(forArticle)) return make(forArticle.code, "user", 100, false, false, false);
  const chosen = findLanguage(siteChoice, registry);
  if (isReadable(chosen)) {
    const textLanguage = textLanguageGuess(detection, chosen.code, registry);
    if (!textLanguage) return make(chosen.code, "user", 100, false, false, true);
    // The text is (probably) in another language: listen in the chosen one by translating.
    if (canTranslate?.(textLanguage, chosen.code)) {
      return { ...make(chosen.code, "user", 100, false, false, true),
        translatedFrom: { code: textLanguage, name: languageName(textLanguage, registry) } };
    }
    // Can't translate: the choice still stands unless the text clearly is another language.
    if (!languageConflict(detection, chosen.code, registry)) return make(chosen.code, "user", 100, false, false, true);
  }
  if (!detection) return null;
  // Nothing to go on at all: suggest English, and ask.
  return make(
    detection.lang ?? DEFAULT_LANGUAGE,
    detection.source === "html" ? "html" : "auto",
    detection.confidence,
    detection.mixed,
    detection.needsConfirm,
    false,
  );
}

/** Voices and the chosen voice for a language (none when Voix can't read it). */
export function voiceState(
  language: ReadingLanguage | null, gender: Gender, registry: Registry, voiceByLang: Record<string, string>,
): Pick<ReaderState, "voices" | "voiceId" | "voiceNotice"> {
  const entry = language?.supported ? findLanguage(language.code, registry) : undefined;
  const pick = entry && pickVoice(entry.code, gender, registry, voiceByLang[entry.code]);
  if (!entry || !pick) return { voices: [], voiceId: "", voiceNotice: undefined };
  return { voices: voicesFor(entry), voiceId: pick.voice.id, voiceNotice: pick.notice };
}

/** The user can start reading: the language is known and Voix (or the device voice) can read it. */
export function canStart(state: Pick<ReaderState, "language" | "usingFallbackVoice">): boolean {
  const l = state.language;
  return !!l && (l.supported || state.usingFallbackVoice);
}
