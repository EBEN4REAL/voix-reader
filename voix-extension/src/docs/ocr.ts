// OCR with Tesseract, fully bundled (worker, WebAssembly core and English
// model are extension files). Runs in the offscreen document.

import { createWorker, OEM, type Worker } from "tesseract.js";
import { browser } from "wxt/browser";

const IDLE_MS = 2 * 60_000; // free the ~100 MB worker when not used for a while

let worker: Promise<Worker> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function getWorker(): Promise<Worker> {
  const url = (p: string) => browser.runtime.getURL(p as "/");
  worker ??= createWorker("eng", OEM.LSTM_ONLY, {
    workerPath: url("/vendor/tesseract/worker.min.js"),
    corePath: url("/vendor/tesseract/tesseract-core-simd-lstm.wasm.js"),
    langPath: url("/vendor/tesseract/lang"),
    workerBlobURL: false,
    gzip: true,
    cacheMethod: "none",
  }).catch((e) => {
    worker = null;
    throw e;
  });
  return worker;
}

export async function recognize(image: HTMLCanvasElement | string): Promise<string> {
  clearTimeout(idleTimer);
  const w = await getWorker();
  try {
    const { data } = await w.recognize(image);
    return data.text;
  } finally {
    idleTimer = setTimeout(() => {
      const old = worker;
      worker = null;
      void old?.then((x) => x.terminate());
    }, IDLE_MS);
  }
}
