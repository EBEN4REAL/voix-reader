import { describe, expect, it } from "vitest";
import {
  BUNDLED_REGISTRY as REG, findLanguage, languageName, parseRegistry, pickVoice, voiceBelongs, type Gender,
} from "../src/lang/registry";
import { languageOptions } from "../src/lang/resolve";

// Kokoro voice prefix letter -> Kokoro language (the same rule server.py enforces).
const PREFIX_LANG: Record<string, string> = {
  a: "en-us", b: "en-gb", e: "es", f: "fr-fr", h: "hi", i: "it", p: "pt-br", j: "ja", z: "cmn",
};

describe("voice registry", () => {
  it("is valid, and every voice belongs to exactly one language", () => {
    expect(parseRegistry(REG)).not.toBeNull();
    const seen = new Set<string>();
    for (const lang of REG.languages) {
      for (const v of lang.voices) {
        if (v.engine === "piper") expect(v.id.split(/[-_]/)[0], v.id).toBe(lang.code); // de_DE-thorsten-medium
        else expect(PREFIX_LANG[v.id[0]!], v.id).toBe(v.kokoroLang ?? lang.kokoroLang);
        expect(seen.has(v.id), v.id).toBe(false);
        seen.add(v.id);
      }
    }
  });

  it("keeps the PRD's eight Kokoro languages, with English unchanged, and adds Piper's", () => {
    expect(REG.languages.slice(0, 8).map((l) => l.code)).toEqual(["en", "es", "fr", "it", "pt", "hi", "ja", "zh"]);
    const en = findLanguage("en", REG)!;
    expect(en.voices).toHaveLength(23);
    expect(en.beta).toBe(false);
    expect(REG.languages.filter((l) => l.code !== "en").every((l) => l.beta)).toBe(true);
    const piper = REG.languages.filter((l) => l.voices.every((v) => v.engine === "piper"));
    expect(piper.length).toBeGreaterThanOrEqual(30);
    expect(piper.every((l) => l.voices.length > 0 && !l.kokoroLang)).toBe(true);
  });

  it("offers enabled languages in the picker, each in its own language, alphabetically", () => {
    const names = languageOptions(REG).map((l) => l.nativeName);
    expect(names).toEqual(expect.arrayContaining(["Deutsch", "English", "Español", "Nederlands", "Polski", "Русский"]));
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "en")));
    expect(names).not.toContain("日本語"); // still waiting for the listening check
  });

  it.each([
    ["es-MX", "es"], ["es-419", "es"], ["pt-PT", "pt"], ["pt-BR", "pt"], ["zh-TW", "zh"], ["zh-Hant", "zh"],
    ["zh-CN", "zh"], ["cmn", "zh"], ["EN_gb", "en"], ["fr-CA", "fr"], ["es-CL", "es"],
    ["de-AT", "de"], ["nl-BE", "nl"], ["nb", "no"], ["sv-FI", "sv"],
  ])("finds %s as %s", (tag, code) => {
    expect(findLanguage(tag, REG)?.code).toBe(code);
  });

  it("has no entry for languages no engine can read (or only under a non-commercial licence)", () => {
    expect(findLanguage("tr", REG)).toBeUndefined();
    expect(findLanguage("yo", REG)).toBeUndefined();
    expect(languageName("tr", REG)).toBe("Turkish");
    expect(languageName("de", REG)).toBe("German");
    expect(languageName("yo", REG)).toBe("Yoruba");
    expect(languageName("es", REG)).toBe("Spanish");
  });

  it("knows which voices belong to which language", () => {
    expect(voiceBelongs("ef_dora", "es", REG)).toBe(true);
    expect(voiceBelongs("ef_dora", "fr", REG)).toBe(false);
    expect(voiceBelongs("bm_george", "en", REG)).toBe(true);
  });

  it("rejects a server response that isn't a registry, and drops malformed voices", () => {
    expect(parseRegistry(null)).toBeNull();
    expect(parseRegistry({ version: 1 })).toBeNull();
    expect(parseRegistry({ version: 1, languages: [{ code: "es" }] })).toBeNull();
    const r = parseRegistry({
      version: 2,
      languages: [{
        code: "es", name: "Spanish", nativeName: "Español", kokoroLang: "es", enabled: true,
        voices: [{ id: "ef_dora", gender: "female", label: "Dora" }, { id: "bad", gender: "robot", label: "?" }],
      }],
    });
    expect(r?.languages[0]).toMatchObject({ aliases: [], beta: false, voices: [{ id: "ef_dora" }] });
  });
});

describe("pickVoice", () => {
  // [language, preferred gender, expected voice, notice]
  const CASES: [string, Gender, string, string | undefined][] = [
    ["en", "female", "af_heart", undefined],
    ["en", "male", "am_eric", undefined],
    ["es", "female", "ef_dora", undefined],
    ["es", "male", "em_alex", undefined],
    ["fr", "female", "ff_siwis", undefined],
    ["fr", "male", "ff_siwis", "Only a female voice is available for French."],
    ["it", "female", "if_sara", undefined],
    ["it", "male", "im_nicola", undefined],
    ["pt", "female", "pf_dora", undefined],
    ["pt", "male", "pm_alex", undefined],
    ["hi", "female", "hf_alpha", undefined],
    ["hi", "male", "hm_omega", undefined],
    ["ja", "female", "jf_alpha", undefined],
    ["ja", "male", "jm_kumo", undefined],
    ["zh", "female", "zf_xiaobei", undefined],
    ["zh", "male", "zm_yunjian", undefined],
  ];

  it.each(CASES)("%s, prefers %s: %s", (lang, gender, voice, notice) => {
    const pick = pickVoice(lang, gender, REG)!;
    expect(pick.voice.id).toBe(voice);
    expect(pick.notice).toBe(notice);
    expect(voiceBelongs(pick.voice.id, findLanguage(lang, REG)!.code, REG)).toBe(true);
  });

  it("covers every Kokoro language", () => {
    const kokoro = REG.languages.filter((l) => l.voices.some((v) => (v.engine ?? "kokoro") === "kokoro"));
    expect(new Set(CASES.map((c) => c[0]))).toEqual(new Set(kokoro.map((l) => l.code)));
  });

  it.each(REG.languages.map((l) => [l.code, l] as const))("%s: a voice of the language for either preference", (code, lang) => {
    for (const gender of ["female", "male"] as const) {
      const pick = pickVoice(code, gender, REG)!;
      expect(voiceBelongs(pick.voice.id, code, REG)).toBe(true);
      const hasGender = lang.voices.some((v) => v.gender === gender);
      expect(pick.voice.gender === gender).toBe(hasGender);
      expect(pick.notice === undefined).toBe(hasGender);
    }
  });

  it("Piper voices: German has both, Dutch knows its accents", () => {
    expect(pickVoice("de", "female", REG)!.voice).toMatchObject({ engine: "piper", gender: "female", locale: "de-DE" });
    expect(pickVoice("de", "male", REG)!.voice).toMatchObject({ engine: "piper", gender: "male" });
    const dutch = findLanguage("nl", REG)!.voices;
    expect(new Set(dutch.map((v) => v.accent))).toEqual(new Set(["BE", "NL"]));
  });

  it("keeps the voice the user chose for a language when it matches their gender", () => {
    expect(pickVoice("es", "male", REG, "em_santa")!.voice.id).toBe("em_santa");
    expect(pickVoice("es", "female", REG, "em_santa")!.voice.id).toBe("ef_dora"); // gender preference wins
    expect(pickVoice("es", "male", REG, "ff_siwis")!.voice.id).toBe("em_alex"); // never another language's voice
  });

  it("gives device-voice locales and Beta flags", () => {
    expect(pickVoice("en", "male", REG, "bm_george")!.voice).toMatchObject({ locale: "en-GB", beta: false, accent: "UK" });
    expect(pickVoice("pt", "female", REG)!.voice).toMatchObject({ locale: "pt-BR", beta: true });
    expect(pickVoice("tr", "female", REG)).toBeNull();
  });
});
