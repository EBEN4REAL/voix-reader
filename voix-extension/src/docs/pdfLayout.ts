// Turns PDF.js text items into readable paragraphs: rebuilds lines, joins
// wrapped lines, splits paragraphs on vertical gaps, and removes running
// headers, footers and page numbers. Pure functions (no PDF.js import) so they
// can be unit-tested.

import { joinLines } from "./text";

export interface TextItem {
  str: string;
  hasEOL: boolean;
  x: number;
  y: number; // baseline, PDF coordinates (grow upwards)
  width: number;
  height: number;
}

export interface Line {
  text: string;
  x: number;
  y: number;
  height: number;
  width: number;
}

export function buildLines(items: TextItem[]): Line[] {
  const lines: Line[] = [];
  let cur: Line | null = null;
  const flush = () => {
    if (cur && cur.text.trim()) lines.push({ ...cur, text: cur.text.replace(/\s+/g, " ").trim() });
    cur = null;
  };
  for (const it of items) {
    if (cur && it.str && Math.abs(it.y - cur.y) > Math.max(cur.height, it.height, 1) * 0.6) flush();
    if (it.str) {
      if (!cur) cur = { text: "", x: it.x, y: it.y, height: it.height, width: 0 };
      const gap = it.x - (cur.x + cur.width);
      if (cur.text && !/\s$/.test(cur.text) && !/^\s/.test(it.str) && gap > it.height * 0.15) cur.text += " ";
      cur.text += it.str;
      cur.width = Math.max(cur.width, it.x + it.width - cur.x);
      cur.height = Math.max(cur.height, it.height);
    }
    if (it.hasEOL) flush();
  }
  flush();
  return lines;
}

const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) * q)]!;
};
const median = (xs: number[]) => quantile(xs, 0.5);

/** Group lines into paragraphs using vertical gaps and short sentence-ending lines. */
export function buildParagraphs(lines: Line[]): string[] {
  if (!lines.length) return [];
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const g = lines[i - 1]!.y - lines[i]!.y;
    if (g > 0) gaps.push(g);
  }
  // Most gaps are ordinary line spacing; paragraph gaps are the minority, so take a low quantile.
  const lineGap = quantile(gaps, 0.3) || median(lines.map((l) => l.height)) * 1.2;
  const fullWidth = median(lines.map((l) => l.width));
  const paragraphs: string[] = [];
  let current: string[] = [];
  lines.forEach((line, i) => {
    const prev = lines[i - 1];
    if (prev) {
      const gap = prev.y - line.y;
      const bigGap = gap > lineGap * 1.45 || gap < -lineGap; // jump up = new column/block
      const shortEnd = prev.width < fullWidth * 0.7 && /[.!?:"”)]$/.test(prev.text);
      const sizeChange = Math.abs(prev.height - line.height) > Math.max(prev.height, line.height) * 0.25;
      if (bigGap || shortEnd || sizeChange) {
        paragraphs.push(joinLines(current));
        current = [];
      }
    }
    current.push(line.text);
  });
  if (current.length) paragraphs.push(joinLines(current));
  return paragraphs.filter((p) => /[\p{L}\p{N}]/u.test(p));
}

// "12", "- 12 -", "Page 3", "3 of 9", "3/9", short roman numerals ("iv").
const PAGE_NUMBER = /^\s*[-–—]?\s*(page\s*)?(\d+|[ivxlc]{1,4})(\s*(of|\/)\s*\d+)?\s*[-–—]?\s*$/i;
const keyOf = (text: string) => text.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();

/**
 * Lines repeated at the top or bottom of most sampled pages (running titles,
 * dates, URLs, "Page 3 of 9") are page furniture, not content.
 */
export interface PageLines {
  lines: Line[];
  /** Page height in PDF units (y grows upwards from the bottom edge). */
  height: number;
}

const MARGIN = 0.07; // headers and footers live in the outer 7% of the page

/** Lines in the top or bottom margin band: the only place running headers/footers sit. */
function marginLines({ lines, height }: PageLines): Line[] {
  return lines.filter((l) => l.y >= height * (1 - MARGIN) || l.y <= height * MARGIN);
}

export function learnRunningLines(pages: PageLines[]): Set<string> {
  const counts = new Map<string, number>();
  for (const page of pages) {
    for (const key of new Set(marginLines(page).map((l) => keyOf(l.text)))) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const needed = Math.max(2, Math.ceil(pages.length * 0.5));
  return new Set([...counts].filter(([, n]) => n >= needed).map(([k]) => k));
}

export function stripFurniture(page: PageLines, running: Set<string>): Line[] {
  const margin = new Set(marginLines(page));
  return page.lines.filter((l) => {
    if (margin.has(l) && running.has(keyOf(l.text))) return false;
    return !PAGE_NUMBER.test(l.text);
  });
}

/** Characters of real text on a page; below a threshold the page is treated as scanned. */
export function textAmount(lines: Line[]): number {
  return lines.reduce((n, l) => n + (l.text.match(/[\p{L}\p{N}]/gu)?.length ?? 0), 0);
}
