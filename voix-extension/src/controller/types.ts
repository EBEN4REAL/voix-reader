export type Status = "idle" | "preparing" | "playing" | "paused" | "error";

export interface Voice {
  id: string;
  label: string;
  gender: "female" | "male";
  /** Speech engine on the server: "kokoro" or "piper". */
  engine: string;
  /** Shown after the name when a language has several accents ("Heart · US"). */
  accent?: string;
  /** BCP 47 tag for the device-voice fallback ("en-GB", "es-ES"). */
  locale: string;
  /** Marked "Beta" in the widget (every non-English Kokoro voice). */
  beta: boolean;
}

export interface Sentence {
  id: string;
  text: string;
  /** Paragraph this sentence belongs to: a language change restarts from the paragraph's start. */
  para?: number;
}

export type SettingKey = "highlightOnPage" | "autoScroll";

export interface LanguageOption {
  code: string;
  name: string;
  /** The language's name in itself ("Español"). */
  nativeName: string;
  beta: boolean;
}

export interface ReadingLanguage {
  /** Registry code ("es"); for a language Voix can't read, the detected code ("de"). */
  code: string;
  /** English name ("Spanish", "German"). */
  name: string;
  /** auto: detected from the text; html: only the page's declaration; user: chosen in the picker. */
  source: "auto" | "html" | "user";
  /** 0 to 100. */
  confidence: number;
  /** A second language makes up a large part of the text. */
  mixed: boolean;
  /** Detection wasn't sure: Play opens the picker and waits for a choice. */
  needsConfirm: boolean;
  /** Voix has natural voices for it. */
  supported: boolean;
  beta: boolean;
  /** Chosen by the user for this website (Reset clears it). */
  savedForSite: boolean;
  /** The text is in another language and is translated into this one before it is read. */
  translatedFrom?: { code: string; name: string };
}

export interface ReaderState {
  status: Status;
  sentences: Sentence[];
  currentIndex: number;
  speed: number; // 0.5 to 3
  voiceId: string;
  /** Voices for the reading language. */
  voices: Voice[];
  usingFallbackVoice: boolean;
  settings: { highlightOnPage: boolean; autoScroll: boolean };
  /** Language detection and the language chip are on (feature flag). */
  multilingual: boolean;
  /** Languages the picker offers. */
  languages: LanguageOption[];
  /** The reading language; null until it is known (Play stays disabled). */
  language: ReadingLanguage | null;
  languagePickerOpen: boolean;
  /**
   * The user picked a language the text clearly isn't in: Voix asks before reading it that way,
   * because it doesn't translate (a German voice would only read English words with an accent).
   */
  languageConflict?: {
    code: string;
    name: string;
    textName: string;
    /** Why Voix can't translate instead: no translator in this browser, or not this pair. */
    reason: "no-translator" | "pair-unsupported";
  };
  /** Voix can't read the text's language, but can translate it into this one. */
  translateOffer?: { code: string; name: string };
  /** One line about translation ("Press Play to get German ready", "Couldn't translate…"). */
  translationNotice?: string;
  /**
   * Translations of the sentences into lang, by sentence index (filled as Voix translates ahead).
   * Kept apart from sentences so translating never looks like a new text to the page.
   */
  translated?: { lang: string; texts: (string | undefined)[] };
  /** One line about the voice, e.g. "Only a female voice is available for French." */
  voiceNotice?: string;
  /** The device has a voice for the reading language (offer "Use my device voice"). */
  deviceVoiceAvailable: boolean;
  /** Human-readable reason when status is "error". */
  error?: string;
  /** What is happening while text is still being prepared (e.g. "Recognising text on page 2 of 9…"). */
  loadingMessage?: string;
}

export interface ReaderController {
  subscribe(listener: (s: ReaderState) => void): () => void;
  getState(): ReaderState;
  play(): void;
  pause(): void;
  stop(): void;
  next(): void;
  previous(): void;
  jumpTo(index: number): void;
  setSpeed(speed: number): void;
  setVoice(voiceId: string): void;
  setSetting(key: SettingKey, value: boolean): void;
  /** Leave the device-voice fallback and retry the natural voice from the current sentence. */
  retryNaturalVoice(): void;
  /**
   * The user picked a language: remembered for this website. If the text clearly is another
   * language, sets languageConflict and waits for confirmLanguageChoice / cancelLanguageChoice.
   */
  setLanguage(code: string): void;
  /** Read this text with the picked language anyway (this article only; not remembered). */
  confirmLanguageChoice(): void;
  /** Keep the text's own language. */
  cancelLanguageChoice(): void;
  openLanguagePicker(): void;
  closeLanguagePicker(): void;
  /** Forget this website's language choice and go back to detection. */
  resetSiteLanguage(): void;
  /** Read a language Voix has no natural voice for with the browser's own voice. */
  useDeviceVoice(): void;
}

export const MIN_SPEED = 0.5;
export const MAX_SPEED = 3;

export function clampSpeed(speed: number): number {
  const rounded = Math.round(speed * 10) / 10;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, rounded));
}
