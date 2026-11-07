import { defineConfig } from "wxt";

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
  filterEntrypoints: store ? ["background", "content", "frame", "offscreen", "options"] : undefined,
  outDir: store ? ".output-store" : ".output", // never overwrite the unpacked dev build
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
