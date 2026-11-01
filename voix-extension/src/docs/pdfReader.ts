// PDF text extraction with PDF.js, page by page, in the offscreen document.
// Pages without a text layer (scans, photos of pages) are rendered and OCR'd.

import * as pdfjs from "pdfjs-dist";
import type { TextItem as PdfTextItem } from "pdfjs-dist/types/src/display/api";
import { browser } from "wxt/browser";
import { buildLines, buildParagraphs, learnRunningLines, stripFurniture, textAmount, type Line, type PageLines } from "./pdfLayout";
import { base64ToBytes, DocError, type DocEvent, type DocJob } from "./protocol";
import { cleanOcrText } from "./text";
import { recognize } from "./ocr";

const vendor = (p: string) => browser.runtime.getURL(`/vendor/pdfjs/${p}` as "/");
pdfjs.GlobalWorkerOptions.workerSrc = vendor("pdf.worker.min.mjs");

const SCANNED_BELOW = 25; // characters of text on a page
const HEADER_SAMPLE = 5; // pages used to learn running headers/footers
const OCR_MAX_WIDTH = 2000; // px; enough for accurate OCR without huge canvases

// The same PDF is often read twice in a row (prompt estimate, then Listen).
const bytesCache = new Map<string, Uint8Array>();

function xhrBytes(url: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url);
    xhr.responseType = "arraybuffer";
    xhr.onload = () => (xhr.response ? resolve(new Uint8Array(xhr.response as ArrayBuffer)) : reject(new Error("empty")));
    xhr.onerror = () => reject(new Error("blocked"));
    xhr.send();
  });
}

async function loadBytes(job: Extract<DocJob, { kind: "pdf" }>): Promise<Uint8Array> {
  if (job.bytesB64) return base64ToBytes(job.bytesB64);
  const cached = bytesCache.get(job.url);
  if (cached) return cached;
  let bytes: Uint8Array;
  if (job.url.startsWith("file:")) {
    bytes = await xhrBytes(job.url).catch(() => {
      throw new DocError("file-access",
        "To read PDFs saved on your computer, turn on \"Allow access to file URLs\" for Voix in chrome://extensions.");
    });
  } else {
    const res = await fetch(job.url, { credentials: "include" }).catch(() => null);
    if (!res?.ok) throw new DocError("fetch-failed", `Couldn't download the PDF${res ? ` (HTTP ${res.status})` : ""}.`);
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  bytesCache.clear();
  bytesCache.set(job.url, bytes);
  return bytes;
}

function toLines(items: unknown[]): Line[] {
  return buildLines(
    (items.filter((i) => typeof (i as PdfTextItem).str === "string") as PdfTextItem[]).map((i) => ({
      str: i.str,
      hasEOL: i.hasEOL,
      x: i.transform[4] as number,
      y: i.transform[5] as number,
      width: i.width,
      height: i.height || Math.hypot(i.transform[2] as number, i.transform[3] as number),
    })),
  );
}

async function renderForOcr(page: pdfjs.PDFPageProxy): Promise<HTMLCanvasElement> {
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.min(2.5, OCR_MAX_WIDTH / base.width) });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // "print" intent: the default "display" rendering waits for requestAnimationFrame, which never
  // fires in the hidden offscreen document.
  await page.render({ canvasContext: ctx, canvas, viewport, intent: "print" }).promise;
  return canvas;
}

export async function runPdfJob(
  job: Extract<DocJob, { kind: "pdf" }>,
  emit: (e: DocEvent) => void,
  isCancelled: () => boolean,
): Promise<void> {
  const { jobId } = job;
  emit({ jobId, type: "progress", message: "Opening PDF…" });
  const data = await loadBytes(job);

  let doc: pdfjs.PDFDocumentProxy;
  const task = pdfjs.getDocument({
      data: data.slice(), // PDF.js transfers (detaches) the buffer; keep the cached copy intact
      cMapUrl: vendor("cmaps/"),
      cMapPacked: true,
      standardFontDataUrl: vendor("standard_fonts/"),
      wasmUrl: vendor("wasm/"),
      iccUrl: vendor("iccs/"),
      enableXfa: false,
    });
  try {
    doc = await task.promise;
  } catch (e) {
    void task.destroy();
    const name = (e as Error)?.name;
    if (name === "PasswordException") throw new DocError("password", "This PDF is password-protected, so Voix can't read it.");
    throw new DocError("invalid", "This file couldn't be opened as a PDF.");
  }

  try {
    const pages = doc.numPages;
    const limit = Math.min(pages, job.maxPages ?? pages);
    const lineCache = new Map<number, PageLines>();
    const linesOf = async (n: number): Promise<PageLines> => {
      let entry = lineCache.get(n);
      if (!entry) {
        const page = await doc.getPage(n);
        const [, y0 = 0, , y1 = 792] = page.view; // [x0, y0, x1, y1] page box in PDF units
        const lines: Line[] = toLines((await page.getTextContent()).items).map((l) => ({ ...l, y: l.y - y0 }));
        entry = { lines, height: y1 - y0 };
        lineCache.set(n, entry);
      }
      return entry;
    };

    const sample: PageLines[] = [];
    for (let n = 1; n <= Math.min(limit, HEADER_SAMPLE); n++) sample.push(await linesOf(n));
    const running = pages > 1
      ? learnRunningLines(sample.filter((p) => textAmount(p.lines) >= SCANNED_BELOW))
      : new Set<string>();

    for (let n = 1; n <= limit; n++) {
      if (isCancelled()) return;
      const pageLines = await linesOf(n);
      lineCache.delete(n);
      let paragraphs: string[];
      if (textAmount(pageLines.lines) < SCANNED_BELOW) {
        if (!job.ocr) {
          paragraphs = [];
        } else {
          emit({ jobId, type: "progress", message: `Recognising text on page ${n} of ${pages}…`, pages });
          try {
            paragraphs = cleanOcrText(await recognize(await renderForOcr(await doc.getPage(n))));
          } catch (e) {
            throw new DocError("ocr-failed", `Text recognition failed: ${(e as Error).message}`);
          }
        }
      } else {
        paragraphs = buildParagraphs(stripFurniture(pageLines, running));
      }
      if (isCancelled()) return;
      emit({ jobId, type: "paragraphs", page: n, pages, paragraphs });
    }
    emit({ jobId, type: "done", pages });
  } finally {
    void task.destroy(); // frees the PDF.js worker
  }
}
