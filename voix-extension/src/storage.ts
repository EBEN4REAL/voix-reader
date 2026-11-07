// Preferences persisted per browser. Uses chrome.storage.local inside the
// extension and falls back to localStorage (dev page, tests).

export interface Prefs {
  speed: number;
  voiceId: string;
  highlightOnPage: boolean;
  autoScroll: boolean;
  /** Distance of the widget from the bottom-right corner, or null for the default spot. */
  position: { right: number; bottom: number } | null;
  privacyAccepted: boolean;
  neverSites: string[];
  serverUrl: string;
  apiKey: string;
}

export const DEFAULT_PREFS: Prefs = {
  speed: 1,
  voiceId: "af_heart",
  highlightOnPage: true,
  autoScroll: true,
  position: null,
  privacyAccepted: false,
  neverSites: [],
  // Set at build time for store releases (WXT_VOIX_SERVER_URL / WXT_VOIX_API_KEY); local server otherwise.
  serverUrl: import.meta.env.WXT_VOIX_SERVER_URL || "http://127.0.0.1:8880",
  apiKey: import.meta.env.WXT_VOIX_API_KEY || "",
};

const PREFIX = "voix:";

interface StorageArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/** chrome.storage.local when running inside the extension (absent in offscreen documents). */
function chromeStorage(): StorageArea | undefined {
  return (globalThis as { chrome?: { storage?: { local?: StorageArea } } }).chrome?.storage?.local;
}

export async function loadPrefs<K extends keyof Prefs>(keys: K[]): Promise<Pick<Prefs, K>> {
  const out = {} as Pick<Prefs, K>;
  const area = chromeStorage();
  const stored: Record<string, unknown> = area
    ? await area.get(keys.map((k) => PREFIX + k))
    : Object.fromEntries(keys.map((k) => {
        const raw = localStorage.getItem(PREFIX + k);
        return [PREFIX + k, raw == null ? undefined : JSON.parse(raw)];
      }));
  for (const k of keys) {
    const v = stored[PREFIX + k];
    out[k] = (v === undefined ? DEFAULT_PREFS[k] : v) as Prefs[K];
  }
  return out;
}

export async function savePrefs(values: Partial<Prefs>): Promise<void> {
  const entries = Object.entries(values).map(([k, v]) => [PREFIX + k, v] as const);
  const area = chromeStorage();
  if (area) await area.set(Object.fromEntries(entries));
  else for (const [k, v] of entries) localStorage.setItem(k, JSON.stringify(v));
}
