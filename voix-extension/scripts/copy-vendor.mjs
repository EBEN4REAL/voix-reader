// Copies PDF.js and Tesseract runtime files into public/vendor so they ship
// inside the extension (MV3 forbids loading code from a CDN).
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const nm = (p) => new URL(`../node_modules/${p}`, import.meta.url);
const out = (p) => new URL(`../public/vendor/${p}`, import.meta.url);

rmSync(out(""), { recursive: true, force: true });
for (const dir of ["pdfjs", "tesseract/lang"]) mkdirSync(out(dir), { recursive: true });

// PDF.js: worker, character maps, standard fonts, image decoders (JBIG2/JPEG 2000 in scanned PDFs), colour profiles.
cpSync(nm("pdfjs-dist/build/pdf.worker.min.mjs"), out("pdfjs/pdf.worker.min.mjs"));
// (quickjs-eval runs JavaScript embedded in PDF forms: not needed for reading, so it's left out.)
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  cpSync(nm(`pdfjs-dist/${dir}`), out(`pdfjs/${dir}`), { recursive: true, filter: (src) => !src.includes("quickjs") });
}
cpSync(nm("pdfjs-dist/LICENSE"), out("pdfjs/LICENSE"));

// Tesseract (OCR): worker, the SIMD + LSTM core (supported by every current Chrome), English model.
// The stock worker falls back to downloading its WebAssembly core and language data from a CDN
// when no path is given. Voix always gives the bundled paths, but the Chrome Web Store rejects any
// package that contains code able to load remote scripts, so the fallbacks are pointed at the
// worker's own folder instead (where those files are bundled).
const STOCK_FALLBACKS = [
  // core: corePath || "https://cdn.jsdelivr.net/npm/tesseract.js-core@v" + version
  [/"https:\/\/cdn\.jsdelivr\.net\/npm\/tesseract\.js-core@v"\.concat\(\w+\.substring\(1\)\)/, '"."'],
  // language data: langPath || "https://cdn.jsdelivr.net/npm/@tesseract.js-data/" + lang + "/4.0.0…"
  [/"https:\/\/cdn\.jsdelivr\.net\/npm\/@tesseract\.js-data\/"\.concat\([^)]*\)/, '"./lang"'],
];
let tesseractWorker = readFileSync(nm("tesseract.js/dist/worker.min.js"), "utf8");
for (const [pattern, local] of STOCK_FALLBACKS) {
  if (!pattern.test(tesseractWorker)) {
    throw new Error(`copy-vendor: Tesseract's worker changed; update the patch for ${pattern} (no CDN code may ship)`);
  }
  tesseractWorker = tesseractWorker.replace(pattern, local);
}
// An old global-object fallback written as code-from-text; never reached in Chrome. Plain globalThis
// keeps the package free of new Function / eval.
tesseractWorker = tesseractWorker.replace('this||new Function("return this")()', "this||globalThis");
writeFileSync(out("tesseract/worker.min.js"), tesseractWorker);
cpSync(nm("tesseract.js-core/tesseract-core-simd-lstm.wasm.js"), out("tesseract/tesseract-core-simd-lstm.wasm.js"));
cpSync(nm("@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz"), out("tesseract/lang/eng.traineddata.gz"));
cpSync(nm("tesseract.js/LICENSE.md"), out("tesseract/LICENSE.md"));

console.log("vendor files copied to public/vendor");
