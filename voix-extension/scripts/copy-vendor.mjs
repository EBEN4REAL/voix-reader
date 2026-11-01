// Copies PDF.js and Tesseract runtime files into public/vendor so they ship
// inside the extension (MV3 forbids loading code from a CDN).
import { cpSync, mkdirSync, rmSync } from "node:fs";

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
cpSync(nm("tesseract.js/dist/worker.min.js"), out("tesseract/worker.min.js"));
cpSync(nm("tesseract.js-core/tesseract-core-simd-lstm.wasm.js"), out("tesseract/tesseract-core-simd-lstm.wasm.js"));
cpSync(nm("@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz"), out("tesseract/lang/eng.traineddata.gz"));
cpSync(nm("tesseract.js/LICENSE.md"), out("tesseract/LICENSE.md"));

console.log("vendor files copied to public/vendor");
