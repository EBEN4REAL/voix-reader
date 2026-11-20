// The voice registry: which languages Voix can read, with which voices. One JSON file
// (voices.json at the repo root) is shared with the server, which serves the live copy at
// GET /v1/voices. The extension bundles it so it works offline or when the server is down.

import bundled from "../../../voices.json";
import type { Voice } from "../controller/types";

export type Gender = "female" | "male";

export interface RegistryVoice {
  id: string;
  gender: Gender;
  label: string;
  /** Speech engine on the server ("kokoro" when absent, "piper"). */
  engine?: string;
  /** Piper: training-data licence, from the voice's model card. */
  license?: string;
  /** Shown after the name when a language has several accents ("Heart · US"). */
  accent?: string;
  /** Kokoro language code when it differs from the language's (UK English voices). */
  kokoroLang?: string;
  /** BCP 47 tag for the device-voice fallback when it differs from the language's. */
  locale?: string;
  beta?: boolean;
}

export interface RegistryLanguage {
  /** Detector code ("es"): what the extension sends as lang. */
  code: string;
  name: string;
  /** The language's name in itself ("Español"), shown in the picker. */
  nativeName: string;
  aliases: string[];
  /** Kokoro's code ("es") for Kokoro voices; only the server uses it. */
  kokoroLang?: string;
  locale?: string;
  enabled: boolean;
  beta: boolean;
  voices: RegistryVoice[];
}

export interface Registry {
  version: number;
  languages: RegistryLanguage[];
}

export const BUNDLED_REGISTRY = bundled as Registry;
export const DEFAULT_LANGUAGE = "en";
export const DEFAULT_GENDER: Gender = "female";

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** A registry from the server, checked before use; null if it isn't one. */
export function parseRegistry(data: unknown): Registry | null {
  const r = data as Registry | null;
  if (!r || typeof r.version !== "number" || !Array.isArray(r.languages)) return null;
  const languages: RegistryLanguage[] = [];
  for (const l of r.languages) {
    if (!l || !str(l.code) || !str(l.name) || !str(l.nativeName) || !Array.isArray(l.voices)) return null;
    const voices = l.voices.filter((v) => v && str(v.id) && str(v.label) && (v.gender === "female" || v.gender === "male"));
    languages.push({
      ...l,
      aliases: Array.isArray(l.aliases) ? l.aliases.filter(str) : [],
      enabled: l.enabled === true,
      beta: l.beta === true,
      voices,
    });
  }
  return { version: r.version, languages };
}

/** Registry entry for a detector code or BCP 47 tag: exact code, then alias, then primary subtag. */
export function findLanguage(tag: string | null | undefined, registry: Registry): RegistryLanguage | undefined {
  if (!tag) return undefined;
  const t = tag.replace(/_/g, "-").toLowerCase();
  const primary = t.split("-")[0];
  return registry.languages.find((l) => l.code.toLowerCase() === t)
    ?? registry.languages.find((l) => l.aliases.some((a) => a.toLowerCase() === t))
    ?? registry.languages.find((l) => l.code.toLowerCase() === primary);
}

/** Voix has natural voices for this language right now. */
export function isReadable(lang: RegistryLanguage | undefined): lang is RegistryLanguage {
  return !!lang && lang.enabled && lang.voices.length > 0;
}

export function voicesFor(lang: RegistryLanguage): Voice[] {
  return lang.voices.map((v) => ({
    id: v.id,
    label: v.label,
    gender: v.gender,
    engine: v.engine ?? "kokoro",
    accent: v.accent,
    locale: v.locale ?? lang.locale ?? lang.code,
    beta: v.beta ?? lang.beta,
  }));
}

/** True only when the voice is one of the language's own: never send a voice with another language. */
export function voiceBelongs(voiceId: string, langCode: string, registry: Registry): boolean {
  const lang = registry.languages.find((l) => l.code === langCode);
  return !!lang && lang.voices.some((v) => v.id === voiceId);
}

export interface VoicePick {
  voice: Voice;
  /** Set when the preferred gender has no voice in this language. */
  notice?: string;
}

/**
 * The voice to read a language with: the voice the user last chose for it (if it matches their
 * gender preference), else the first voice of that gender, else a voice of the other gender plus
 * a one-line notice. Null when the language has no voices.
 */
export function pickVoice(
  langCode: string, preferredGender: Gender, registry: Registry, savedVoiceId?: string,
): VoicePick | null {
  const lang = findLanguage(langCode, registry);
  if (!lang || !lang.voices.length) return null;
  const voices = voicesFor(lang);
  const saved = voices.find((v) => v.id === savedVoiceId && v.gender === preferredGender);
  if (saved) return { voice: saved };
  const same = voices.find((v) => v.gender === preferredGender);
  if (same) return { voice: same };
  const other = voices[0]!;
  return { voice: other, notice: `Only a ${other.gender} voice is available for ${lang.name}.` };
}

/** English name for any language code, including ones the registry doesn't have ("de" -> "German"). */
export function languageName(code: string, registry: Registry): string {
  const entry = findLanguage(code, registry);
  if (entry) return entry.name;
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}
