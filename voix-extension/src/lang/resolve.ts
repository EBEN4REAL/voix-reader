// Which language to read in, and with which voice. Pure functions shared by the real and
// mock controllers.

import type { LanguageOption, ReaderState, ReadingLanguage } from "../controller/types";
import type { Detection } from "./detect";
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
  /** The user's choice for this website. Always wins over detection. */
  siteChoice?: string;
  /** Languages the server refused this session (language_not_supported). */
  refused?: ReadonlySet<string>;
}

/** The reading language, or null while it isn't known yet (Play stays disabled). */
export function resolveLanguage(
  { registry, multilingual, detection, siteChoice, refused }: LanguageInputs,
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
  const chosen = findLanguage(siteChoice, registry);
  if (isReadable(chosen)) return make(chosen.code, "user", 100, false, false, true);
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
