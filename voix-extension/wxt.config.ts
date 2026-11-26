import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { defineConfig } from "wxt";
import { findRemoteCode } from "./scripts/remote-code";

/**
 * The Chrome Web Store rejects packages containing code that could load scripts from the web
 * (Manifest V3, "remotely hosted code"). Voix always uses the bundled OCR worker (src/docs/ocr.ts),
 * but tesseract.js ships two ways to load one from elsewhere; both are replaced at build time:
 * its default worker URL (a CDN copy) and its "worker from a blob" launcher (importScripts of a URL).
 */
const TESSERACT_PATCHES: [file: string, pattern: RegExp, replacement: string][] = [
  [
    "tesseract.js/src/worker/browser/defaultOptions.js",
    /`https:\/\/cdn\.jsdelivr\.net\/npm\/tesseract\.js@v\$\{version\}\/dist\/worker\.min\.js`/,
    '"/vendor/tesseract/worker.min.js"',
  ],
  [
    "tesseract.js/src/worker/browser/spawnWorker.js",
    /module\.exports = \(\{ workerPath, workerBlobURL \}\) => \{[\s\S]*\};\s*$/,
    "module.exports = ({ workerPath }) => new Worker(workerPath);\n",
  ],
];

function bundledTesseractWorker(): Plugin {
  return {
    name: "voix-bundled-tesseract-worker",
    enforce: "pre",
    transform(code, id) {
      const file = id.replace(/\\/g, "/");
      const patch = TESSERACT_PATCHES.find(([name]) => file.endsWith(name));
      if (!patch) return;
      const patched = code.replace(patch[1], patch[2]);
      if (patched === code) this.error(`${patch[0]} changed: update this patch (no remotely loaded code may ship)`);
      return patched;
    },
  };
}

// The voice registry is shared with the server and lives at the repo root (one source of truth).
const registry = fileURLToPath(new URL("../voices.json", import.meta.url));

// Store builds (npm run zip:store) leave out the dev page and must name the voice server:
// the deployed one over HTTPS, or the local one (http://127.0.0.1:8880) for a test release.
const store = process.env.VOIX_STORE === "1";
const serverUrl = process.env.WXT_VOIX_SERVER_URL ?? "";
if (store && !/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$))/.test(serverUrl)) {
  throw new Error(
    "Store builds need WXT_VOIX_SERVER_URL: https://<your voice server>, " +
      "or http://127.0.0.1:8880 for a test release that uses the local server (see README).",
  );
}

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  // Let the dev server read the registry outside this folder (builds bundle it either way).
  vite: () => ({ server: { fs: { allow: [".", registry] } }, plugins: [bundledTesseractWorker()] }),
  filterEntrypoints: store ? ["background", "content", "frame", "offscreen", "options"] : undefined,
  outDir: store ? ".output-store" : ".output", // never overwrite the unpacked dev build
  hooks: {
    // Manifest V3: all code must ship in the package. Fail the build (before any zip is made)
    // if anything could load code from the web.
    "build:done": (wxt) => {
      const found = findRemoteCode(wxt.config.outDir);
      if (found.length) {
        throw new Error(`Remotely hosted code in the build (the Chrome Web Store rejects this):\n  ${found.join("\n  ")}`);
      }
    },
  },
  manifest: {
    name: "Voix",
    description: "Listen to any article, in a natural voice.",
    permissions: ["storage", "offscreen", "scripting", "activeTab"],
    host_permissions: ["<all_urls>"],
    icons: { 16: "icon/16.png", 32: "icon/32.png", 48: "icon/48.png", 128: "icon/128.png" },
    action: {
      default_title: "Voix: listen to this page",
      default_icon: { 16: "icon/16.png", 32: "icon/32.png", 48: "icon/48.png", 128: "icon/128.png" },
    },
    commands: {
      "toggle-voix": {
        suggested_key: { default: "Alt+Shift+V" },
        description: "Open or close the Voix reader",
      },
    },
    web_accessible_resources: [{ resources: ["fonts/*"], matches: ["<all_urls>"] }],
    // PDF.js image decoders and Tesseract OCR are WebAssembly (bundled, never remote).
    content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';" },
  },
});
