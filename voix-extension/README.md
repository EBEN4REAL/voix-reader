# Voix browser extension

Floating reader widget that reads web articles aloud in natural voices, using
the Kokoro server in the parent folder (`../server.py`). Built with WXT
(Manifest V3), TypeScript (strict) and React 18.

## Run it

```bash
npm install
npm run build                     # output: .output/chrome-mv3
```

1. Start the voice server: `cd .. && ./start.sh` (http://127.0.0.1:8880).
2. Chrome → `chrome://extensions` → **Developer mode** → **Load unpacked** → pick `.output/chrome-mv3`.
3. Open an article. After ~1.5 s the **Listen to this article?** card appears; or click the Voix
   toolbar icon, or press **Alt+Shift+V** (change it at `chrome://extensions/shortcuts`).

Server URL and API key: right-click the toolbar icon → **Options**.
After code changes: `npm run build`, then click reload on `chrome://extensions`.
`npm run dev` starts WXT's dev mode with auto-reload.

## Dev page (every state, no server needed)

`chrome-extension://<extension-id>/dev.html` renders the real widget in a Shadow DOM over a sample
article, driven by `MockReaderController`, with buttons for each state: expanded, preparing,
device-voice fallback, prompt card, no article, minimised pill, privacy notice, blocked site, error.
`dev.html#state=3` deep-links to a state. It also works from a plain web server:
`cd .output/chrome-mv3 && python3 -m http.server` then open `/dev.html`.

## What it can read

| Document | How |
|---|---|
| Articles and web pages | Page text, including web components (open Shadow DOM); highlighted as it's read |
| Documents inside iframes (e.g. Word for the web, online viewers) | `frame.content.ts` in every frame; highlighted inside the frame |
| PDFs: opened in Chrome, embedded in a page, or local files | PDF.js in the offscreen document; headers, footers, page numbers and line-break hyphens removed |
| Scanned PDFs (pages are images) | Tesseract OCR, page by page, so reading starts after the first page |
| Google Docs, Slides, Sheets | Google's text/CSV export (falls back to on-screen OCR if downloading is disabled) |
| Plain-text files (.txt, .md, .csv) | Read from the page, hard-wrapped lines joined |
| Anything drawn on a canvas or as an image | "Read the whole page" recognises the text on screen (OCR) |

Chrome's PDF viewer and Google Docs' canvas can't be highlighted by extensions, so for those the
widget's sentence list is what follows along.

Local files need **Allow access to file URLs** (chrome://extensions → Voix → Details).

## How it fits together

```
content script (top frame)             background (service worker)        offscreen document
  picks the source for the page   --->   toolbar icon, Alt+Shift+V   --->   audio from the Kokoro server
  Widget (React, Shadow DOM)             routes engine + doc messages        PDF.js text extraction
  VoixReaderController           <---    screenshots for OCR         <---    Tesseract OCR
  page highlight + auto-scroll           frame extraction
  device-voice fallback (speechSynthesis)
frame content script (every iframe): extraction + highlight for documents inside frames
```

- `src/controller/types.ts`: the `ReaderController` interface the UI is built against.
- `src/controller/mock.ts`: timer-driven mock (dev page and tests).
- `src/controller/reader.ts`: real controller; falls back to the browser voice if the natural voice fails.
- `src/ui/`: widget components, tokens in `widget.css`.
- `src/page/`: page extraction (skips nav, sidebars, footers, adverts, code; walks Shadow DOM), on-page
  highlight, sensitive-site check.
- `src/docs/`: PDF reading (`pdfReader.ts`, layout clean-up in `pdfLayout.ts`), OCR (`ocr.ts`), text helpers
  (sentences, Google export URLs, CSV).
- `src/content/sessions.ts`: how each source follows the current sentence (DOM, frame, text-only).
- PDF.js and Tesseract runtime files are copied into `public/vendor/` by `scripts/copy-vendor.mjs` (runs on
  install and before every build); nothing is loaded from a CDN.
- `src/voices.json`: voice catalog (names, gender, accent) shown in the voice picker.
- Icons: SVG sources in `assets/icon/`, PNGs regenerated with `npm run icons`.
- Font: Plus Jakarta Sans (OFL) bundled in `public/fonts/`, registered on the page with the FontFace
  API, because `@font-face` doesn't work inside a Shadow DOM.

## Tests

```bash
npm test            # unit + component tests (Vitest, Testing Library)
npm run typecheck
```

### End-to-end test

Loads the built extension in Chrome for Testing and checks the full flow against a real Kokoro
server: prompt card, privacy notice, playback, page highlight, speed, pause/resume, minimise,
fallback, toolbar toggle, no-article card.

```bash
npx @puppeteer/browsers install chrome@stable --path /tmp/cft          # once; prints the binary path
(cd .. && PORT=8899 ./start.sh) &                                      # test voice server
(cd e2e/site && python3 -m http.server 8766) &                         # test pages
(cd e2e/site/other && python3 -m http.server 8767) &                   # second origin (iframe test)
npm run build
CHROME_PATH="<printed binary path>" npm run e2e         # widget: prompt, playback, controls, fallback
CHROME_PATH="<printed binary path>" npm run e2e:docs    # every document type (needs internet for Google)
```

Screenshots land in `e2e/screenshots/`.

## Notes

- Kokoro has US and UK English voices only; the brief's Nigerian-accent examples ("Ezinne", "Abeo")
  have no Kokoro voice, so they are not in `voices.json`. Add entries there when a voice exists.
- The sensitive-site check (`src/page/sensitive.ts`) is a simple host list (email providers,
  payment sites, any host containing "bank"). Extend it before a public release.
- `host_permissions` is `<all_urls>` so the prompt card can run on any article.
- OCR is English only (`@tesseract.js-data/eng`) and adds ~7 MB; PDF.js adds ~6 MB.
- Not supported: password-protected PDFs (a clear message is shown), closed Shadow DOM, and text selected
  inside PDFs, Google Docs or iframes (the whole document is read; click a sentence to jump).
