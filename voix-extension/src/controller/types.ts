export type Status = "idle" | "preparing" | "playing" | "paused" | "error";

export interface Voice {
  id: string;
  label: string;
  gender: "woman" | "man";
  accent: string;
}

export interface Sentence {
  id: string;
  text: string;
}

export type SettingKey = "highlightOnPage" | "autoScroll";

export interface ReaderState {
  status: Status;
  sentences: Sentence[];
  currentIndex: number;
  speed: number; // 0.5 to 3
  voiceId: string;
  voices: Voice[];
  usingFallbackVoice: boolean;
  settings: { highlightOnPage: boolean; autoScroll: boolean };
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
}

export const MIN_SPEED = 0.5;
export const MAX_SPEED = 3;

export function clampSpeed(speed: number): number {
  const rounded = Math.round(speed * 10) / 10;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, rounded));
}
