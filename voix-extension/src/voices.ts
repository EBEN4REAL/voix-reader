import catalog from "./voices.json";
import type { Voice } from "./controller/types";

export const VOICES = catalog as Voice[];
export const DEFAULT_VOICE = "af_heart";

/** BCP 47 tag for a voice, used by the device-voice fallback. */
export function voiceLang(voice: Voice | undefined): string {
  return voice?.accent === "UK" ? "en-GB" : "en-US";
}
