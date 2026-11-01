// Messages for document jobs (PDF text extraction, OCR) that run in the
// offscreen document. content script -> background -> offscreen, and events
// back the same way.

export type DocRequest =
  /** Extract a PDF, page by page. bytesB64 is used when only the page itself can fetch the file. */
  | { kind: "pdf"; jobId: string; url: string; bytesB64?: string; ocr: boolean; maxPages?: number }
  /** OCR whatever is visible in the tab (the background captures the screenshot). */
  | { kind: "ocr-screen"; jobId: string }
  | { kind: "cancel"; jobId: string };

/** What the background forwards to the offscreen document. */
export type DocJob =
  | Extract<DocRequest, { kind: "pdf" | "cancel" }>
  | { kind: "ocr-image"; jobId: string; dataUrl: string };

export type DocErrorCode = "fetch-failed" | "file-access" | "password" | "invalid" | "ocr-failed" | "unknown";

export type DocEvent =
  | { jobId: string; type: "progress"; message: string; pages?: number }
  | { jobId: string; type: "paragraphs"; page: number; pages: number; paragraphs: string[] }
  | { jobId: string; type: "done"; pages: number }
  | { jobId: string; type: "error"; code: DocErrorCode; message: string };

export class DocError extends Error {
  constructor(public code: DocErrorCode, message: string) {
    super(message);
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
