// Keeping the voice registry current: the server's copy (GET /v1/voices) is fetched by the
// background at most once a day and stored; the bundled copy covers offline use and first runs.

import { browser } from "wxt/browser";
import { loadPrefs, savePrefs } from "../storage";
import { BUNDLED_REGISTRY, parseRegistry, type Registry } from "./registry";

export const REGISTRY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The newest registry this browser has, and whether it is due a refresh. */
export async function storedRegistry(): Promise<{ registry: Registry; stale: boolean }> {
  const { registry } = await loadPrefs(["registry"]);
  const parsed = registry ? parseRegistry(registry.data) : null;
  // A copy older than the one this build ships (e.g. fetched before new languages were added) is ignored.
  if (!parsed || !registry || parsed.version < BUNDLED_REGISTRY.version) return { registry: BUNDLED_REGISTRY, stale: true };
  return { registry: parsed, stale: Date.now() - registry.fetchedAt > REGISTRY_MAX_AGE_MS };
}

/** GET /v1/voices and store it. Null when the server can't be reached or sends something else. */
export async function fetchRegistry(server: { url: string; apiKey: string }): Promise<Registry | null> {
  try {
    const res = await fetch(`${server.url.replace(/\/+$/, "")}/v1/voices`, {
      headers: server.apiKey ? { Authorization: `Bearer ${server.apiKey}` } : {},
    });
    if (!res.ok) return null;
    const registry = parseRegistry(await res.json());
    if (registry) await savePrefs({ registry: { data: registry, fetchedAt: Date.now() } });
    return registry;
  } catch {
    return null;
  }
}

/** From a content script: the registry, refreshed by the background when stale (or now, if forced). */
export async function requestRegistry(force: boolean): Promise<Registry | null> {
  const res = await browser.runtime.sendMessage({ target: "background", registry: { force } }).catch(() => null);
  return parseRegistry(res);
}
