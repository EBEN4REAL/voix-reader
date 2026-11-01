import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
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
