import { describe, expect, it } from "vitest";
import { buildLines, buildParagraphs, learnRunningLines, stripFurniture, type TextItem } from "../src/docs/pdfLayout";
import {
  cleanOcrText, googleExportUrl, joinLines, MAX_CHUNK_CHARS, parseCsv, plainTextParagraphs, sentenceSpans, sheetParagraphs,
  splitParagraphs, splitSentences,
} from "../src/docs/text";

describe("text helpers", () => {
  it("splits paragraphs into sentences and drops punctuation-only fragments", () => {
    expect(splitSentences(["Dr. Smith arrived. He sat down!", "— —", "Why? Because."]))
      .toEqual(["Dr. Smith arrived.", "He sat down!", "Why?", "Because."]);
  });

  it("joins wrapped lines and removes line-break hyphens only", () => {
    expect(joinLines(["The quick exam-", "ple shows a well-", "Known case of long-", "term thinking."]))
      .toBe("The quick example shows a well- Known case of longterm thinking.");
  });

  it("cleans OCR output into paragraphs and drops noise", () => {
    const text = "First line of a para-\ngraph that wraps.\n\n|| ~~ ;;\n\nSecond paragraph.";
    expect(cleanOcrText(text)).toEqual(["First line of a paragraph that wraps.", "Second paragraph."]);
  });

  it("plain text: one paragraph per line, but hard-wrapped blocks are joined", () => {
    expect(plainTextParagraphs("﻿Title\r\nFirst paragraph.\r\n\r\nSecond.")).toEqual(["Title", "First paragraph.", "Second."]);
    const wrapped = "This is a hard wrapped paragraph from a text file that keeps\ngoing on the next line until it finally ends here.";
    expect(plainTextParagraphs(wrapped)).toHaveLength(1);
  });

  it("parses CSV with quotes and reads rows as cell lists", () => {
    expect(parseCsv('a,"b, c","say ""hi"""\n1,,3\n')).toEqual([["a", "b, c", 'say "hi"'], ["1", "", "3"]]);
    expect(sheetParagraphs("Name,Score\nAda,10\n,,\n")).toEqual(["Name, Score", "Ada, 10"]);
  });

  it("maps Google editor URLs to their text export", () => {
    expect(googleExportUrl("https://docs.google.com/document/d/abc_123/edit?tab=t.0"))
      .toEqual({ kind: "document", url: "https://docs.google.com/document/d/abc_123/export?format=txt" });
    expect(googleExportUrl("https://docs.google.com/document/u/1/d/abc/edit")?.url)
      .toBe("https://docs.google.com/document/u/1/d/abc/export?format=txt");
    expect(googleExportUrl("https://docs.google.com/presentation/d/xyz/edit#slide=id.p")?.url)
      .toBe("https://docs.google.com/presentation/d/xyz/export/txt");
    expect(googleExportUrl("https://docs.google.com/spreadsheets/d/s1/edit#gid=42")?.url)
      .toBe("https://docs.google.com/spreadsheets/d/s1/export?format=csv&gid=42");
    // Published-to-web pages are normal HTML; other sites are not Google Docs.
    expect(googleExportUrl("https://docs.google.com/document/d/e/2PACX-1/pub")).toBeNull();
    expect(googleExportUrl("https://example.com/document/d/abc/edit")).toBeNull();
  });
});

const item = (str: string, x: number, y: number, hasEOL = true, width = str.length * 6, height = 12): TextItem =>
  ({ str, x, y, width, height, hasEOL });

describe("PDF layout", () => {
  it("rebuilds lines from text items", () => {
    const lines = buildLines([item("Hello", 72, 700, false, 30), item("world.", 105, 700), item("Next line", 72, 686)]);
    expect(lines.map((l) => l.text)).toEqual(["Hello world.", "Next line"]);
  });

  it("splits paragraphs on vertical gaps and joins hyphenated lines", () => {
    const lines = buildLines([
      item("The first paragraph is long enough to fill the line and con-", 72, 700, true, 400),
      item("tinues here on the second line of the same paragraph text.", 72, 686, true, 400),
      item("A second paragraph starts after a gap that is much bigger.", 72, 650, true, 400),
    ]);
    expect(buildParagraphs(lines)).toEqual([
      "The first paragraph is long enough to fill the line and continues here on the second line of the same paragraph text.",
      "A second paragraph starts after a gap that is much bigger.",
    ]);
  });

  it("removes running headers, footers and page numbers", () => {
    const page = (n: number) => ({
      height: 842,
      lines: buildLines([
        item("10/31/26, 9:41 AM   Annual Report", 20, 820),
        item("A line that repeats in the body of every page.", 72, 760),
        item(`Body text on page ${n} with real content in it.`, 72, 700),
        item(`file:///reports/annual.pdf   ${n}/3`, 20, 20),
      ]),
    });
    const pages = [page(1), page(2), page(3)];
    const running = learnRunningLines(pages);
    // Repeated body text outside the margins is kept; only margin furniture goes.
    expect(stripFurniture(pages[1]!, running).map((l) => l.text)).toEqual([
      "A line that repeats in the body of every page.",
      "Body text on page 2 with real content in it.",
    ]);
    const numbered = { height: 842, lines: buildLines([item("Real sentence here.", 72, 700), item("- 7 -", 300, 30), item("Page 7 of 9", 300, 20)]) };
    expect(stripFurniture(numbered, new Set()).map((l) => l.text)).toEqual(["Real sentence here."]);
  });
});

describe("chunking for the voice service", () => {
  // Sentences of 40 to 120 characters, so they never line up with the 800 limit.
  const ja = Array.from({ length: 60 }, (_, i) => "今日は新しい政策について話します" + "とても".repeat(i % 30) + "。").join("");
  const zh = Array.from({ length: 60 }, (_, i) => "今天我们讨论新的经济政策" + "非常".repeat(i % 30) + "！").join("");

  it.each([["ja", ja], ["zh", zh]])("%s: chunks of at most 800 characters, each a whole sentence", (lang, text) => {
    const chunks = splitSentences([text], lang);
    expect(chunks.length).toBeGreaterThan(50);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
      expect(c).toMatch(/[。！]$/u); // ends where a sentence ends
    }
    expect(chunks.join("")).toBe(text);
  });

  it("breaks a sentence only when it alone is over the limit, at a clause boundary", () => {
    const clause = "これは非常に長い文の一部です、";
    const long = clause.repeat(80) + "終わり。";
    const chunks = splitSentences([long], "ja");
    expect(long.length).toBeGreaterThan(MAX_CHUNK_CHARS);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks.slice(0, -1)) {
      expect(c.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
      expect(c.endsWith("、")).toBe(true);
    }
    expect(chunks.join("")).toBe(long);
  });

  it("breaks an over-long English sentence after a comma, else at a space", () => {
    const long = "one two three four five, ".repeat(50) + "end.";
    const spans = sentenceSpans(long, "en");
    expect(spans.length).toBeGreaterThan(1);
    for (const [a, b] of spans) expect(b - a).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    expect(long.slice(spans[0]![0], spans[0]![1]).trimEnd().endsWith(",")).toBe(true);
    const words = "word ".repeat(400);
    for (const [a, b] of sentenceSpans(words, "en")) expect(b - a).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
  });

  it("keeps the paragraph of each sentence", () => {
    expect(splitParagraphs(["Uno. Dos.", "Tres."], "es", 4)).toEqual([
      { text: "Uno.", para: 4 }, { text: "Dos.", para: 4 }, { text: "Tres.", para: 5 },
    ]);
  });

  it("survives a malformed page language", () => {
    expect(splitSentences(["One. Two."], "not a tag!")).toEqual(["One.", "Two."]);
  });
});
