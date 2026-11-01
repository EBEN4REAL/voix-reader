// Text helpers shared by every non-HTML source (PDF, OCR, Google Docs, plain text).

const HAS_WORD = /[\p{L}\p{N}]/u;

// Intl.Segmenter ends a sentence after any "word." — titles, initials and common
// abbreviations ("Dr. Smith", "J. R. Tolkien", "e.g. this") shouldn't split.
const ABBREVIATION_END = new RegExp(
  "(?:^|[\\s(\"'“])(?:mr|mrs|ms|dr|prof|sr|jr|st|mt|vs|e\\.g|i\\.e|cf|no|nos|fig|figs|vol|pp|ch|sec|" +
    "inc|ltd|co|corp|gen|gov|sen|rep|capt|lt|col|sgt|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec|u\\.s|u\\.k|[a-z])\\.\\s*$",
  "i",
);

/** True when a segment ends in an abbreviation, so the next segment continues the same sentence. */
export function endsWithAbbreviation(segment: string): boolean {
  return ABBREVIATION_END.test(segment);
}

/** Sentence segments of one paragraph as [start, end) offsets, abbreviation splits merged. */
export function sentenceSpans(text: string, lang?: string): [number, number][] {
  const spans: [number, number][] = [];
  let open = false;
  for (const { segment, index } of new Intl.Segmenter(lang, { granularity: "sentence" }).segment(text)) {
    const end = index + segment.length;
    if (open && spans.length) spans[spans.length - 1]![1] = end;
    else spans.push([index, end]);
    open = endsWithAbbreviation(segment);
  }
  return spans;
}

/** Split paragraphs into sentences, dropping fragments with no letters or digits. */
export function splitSentences(paragraphs: string[], lang?: string): string[] {
  const out: string[] = [];
  for (const p of paragraphs) {
    for (const [start, end] of sentenceSpans(p, lang)) {
      const s = p.slice(start, end).replace(/\s+/g, " ").trim();
      if (HAS_WORD.test(s)) out.push(s);
    }
  }
  return out;
}

/**
 * Join wrapped lines into one paragraph: "exam-" + "ple" becomes "example",
 * but "well-" + "Known" (capitalised) and real dashes keep the hyphen.
 */
export function joinLines(lines: string[]): string {
  let text = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (!text) text = line;
    else if (/[\p{Ll}]-$/u.test(text) && /^\p{Ll}/u.test(line)) text = text.slice(0, -1) + line;
    else text += " " + line;
  }
  return text;
}

/** Tesseract output: paragraphs separated by blank lines, lines wrapped. Drops noise. */
export function cleanOcrText(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => joinLines(block.split("\n")))
    .filter((p) => {
      const letters = (p.match(/[\p{L}\p{N}]/gu) ?? []).length;
      return p.length > 1 && letters / p.replace(/\s/g, "").length >= 0.5;
    });
}

/** Plain text (Google Docs export, .txt files): one paragraph per block of lines. */
export function plainTextParagraphs(text: string): string[] {
  return text
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .flatMap((block) => {
      const lines = block.split("\n");
      // Hard-wrapped text (lines of similar length) is one paragraph; otherwise each line stands alone
      // (Google Docs exports one paragraph per line).
      const wrapped = lines.length > 1 && lines.slice(0, -1).every((l) => l.length >= 50 && l.length <= 100);
      return wrapped ? [joinLines(lines)] : lines.map((l) => l.trim());
    })
    .filter((p) => HAS_WORD.test(p));
}

/** Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, newlines in quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Spreadsheet rows read aloud as "cell, cell, cell", skipping empty cells and rows. */
export function sheetParagraphs(csv: string): string[] {
  return parseCsv(csv)
    .map((r) => r.map((c) => c.trim()).filter(Boolean).join(", "))
    .filter((r) => HAS_WORD.test(r));
}

export type GoogleKind = "document" | "presentation" | "spreadsheets";

/** Google's own export endpoint for a Docs/Slides/Sheets editor URL, or null. */
export function googleExportUrl(href: string): { kind: GoogleKind; url: string } | null {
  const u = new URL(href);
  if (u.hostname !== "docs.google.com") return null;
  const m = u.pathname.match(/^(\/(document|presentation|spreadsheets)(?:\/u\/\d+)?\/d\/(?!e\/)[\w-]+)/);
  if (!m) return null;
  const base = `${u.origin}${m[1]}`;
  const kind = m[2] as GoogleKind;
  if (kind === "document") return { kind, url: `${base}/export?format=txt` };
  if (kind === "presentation") return { kind, url: `${base}/export/txt` };
  const gid = (u.hash.match(/gid=(\d+)/) ?? u.search.match(/gid=(\d+)/))?.[1] ?? "0";
  return { kind, url: `${base}/export?format=csv&gid=${gid}` };
}

/** Rough listening time at 1.0x (natural speech is ~150 words per minute). */
export function estimateMinutes(sentences: string[]): number {
  const words = sentences.join(" ").split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 150));
}
