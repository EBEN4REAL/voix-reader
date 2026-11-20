import { describe, expect, it, vi } from "vitest";

vi.mock("wxt/browser", () => ({ browser: {} }));

import { BUNDLED_REGISTRY } from "../src/lang/registry";
import { storedRegistry } from "../src/lang/remote";
import { savePrefs } from "../src/storage";

describe("storedRegistry", () => {
  it("uses the bundled registry until the server's has been fetched", async () => {
    expect(await storedRegistry()).toEqual({ registry: BUNDLED_REGISTRY, stale: true });
  });

  it("uses a fresh copy from the server", async () => {
    const fromServer = { ...BUNDLED_REGISTRY, languages: BUNDLED_REGISTRY.languages.slice(0, 2) };
    await savePrefs({ registry: { data: fromServer, fetchedAt: Date.now() } });
    const { registry, stale } = await storedRegistry();
    expect(stale).toBe(false);
    expect(registry.languages.map((l) => l.code)).toEqual(["en", "es"]);
  });

  it("refreshes a copy over a day old", async () => {
    await savePrefs({ registry: { data: BUNDLED_REGISTRY, fetchedAt: Date.now() - 25 * 60 * 60 * 1000 } });
    expect((await storedRegistry()).stale).toBe(true);
  });

  it("ignores a copy older than the bundled registry (fetched before languages were added)", async () => {
    const old = { version: BUNDLED_REGISTRY.version - 1, languages: BUNDLED_REGISTRY.languages.slice(0, 8) };
    await savePrefs({ registry: { data: old, fetchedAt: Date.now() } });
    expect(await storedRegistry()).toEqual({ registry: BUNDLED_REGISTRY, stale: true });
  });
});
