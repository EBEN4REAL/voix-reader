import { sentenceSpans } from "../docs/text";

// Finds the readable text on the page and splits it into sentences, keeping
// enough DOM information to highlight each sentence while it is read.
// Walks the rendered tree, including open Shadow DOM (web components).

const MIN_ARTICLE_CHARS = 500;

// Page chrome, adverts and non-prose. A user selection or plain-text document only skips the last group.
const SKIP_PAGE = [
  "nav", "aside", "footer", "header nav", "button", "select", "textarea", "pre", "code", "sup",
  "[aria-hidden='true']", "[role='navigation']", "[role='complementary']",
  "ins.adsbygoogle", "[class~='ad']", "[class~='ads']", "[class*='advert']", "[id*='advert']",
  "[class*='sponsor']", "[data-ad]", "[data-ad-slot]", "[aria-label*='advert' i]",
].join(", ");
const SKIP_ALWAYS = "script, style, noscript, svg, math, template, [hidden], voix-widget";

interface Piece {
  node: Text;
  start: number;
  end: number;
  offset: number; // position of this piece within the paragraph text
}

interface Paragraph {
  block: Element;
  pieces: Piece[];
  text: string;
}

export interface Chunk {
  text: string;
  pieces: Piece[];
  start: number;
  end: number;
}

export type ExtractMode = "article" | "page" | "selection" | "plain";

/** Parent in the rendered tree: slot for slotted nodes, host for shadow roots. */
function composedParent(node: Node): Element | null {
  const el = node as Element & { assignedSlot?: HTMLSlotElement | null };
  if (el.assignedSlot) return el.assignedSlot;
  if (node.parentElement) return node.parentElement;
  const root = node.parentNode;
  return root instanceof ShadowRoot ? root.host : null;
}

/** All open shadow roots in the document (web components). */
function shadowRoots(root: Document | ShadowRoot = document, out: ShadowRoot[] = []): ShadowRoot[] {
  for (const el of root.querySelectorAll("*")) {
    if (el.shadowRoot && el.localName !== "voix-widget") {
      out.push(el.shadowRoot);
      shadowRoots(el.shadowRoot, out);
    }
  }
  return out;
}

function deepQueryAll(selector: string, doc: Document = document): Element[] {
  const scopes: (Document | ShadowRoot)[] = [doc, ...shadowRoots(doc)];
  return scopes.flatMap((s) => [...s.querySelectorAll(selector)]);
}

function paragraphTextLength(el: Element): number {
  let n = 0;
  const scopes: (Element | ShadowRoot)[] = [el, ...(el.shadowRoot ? [el.shadowRoot] : [])];
  for (const s of scopes) for (const p of s.querySelectorAll("p")) n += p.textContent?.length ?? 0;
  return n;
}

/** The <article>/<main> with the most paragraph text, if it has enough to be an article. */
export function findArticle(doc: Document = document): Element | null {
  let best: Element | null = null;
  let bestLen = 0;
  for (const el of deepQueryAll("article, main, [role='main']", doc)) {
    const len = paragraphTextLength(el);
    if (len > bestLen) { best = el; bestLen = len; }
  }
  if (best && bestLen >= MIN_ARTICLE_CHARS) return best;
  // Many sites have no semantic wrapper: fall back to the parent of the most <p> text.
  const counts = new Map<Element, number>();
  for (const p of deepQueryAll("p", doc)) {
    const parent = composedParent(p);
    if (parent) counts.set(parent, (counts.get(parent) ?? 0) + (p.textContent?.length ?? 0));
  }
  let top: Element | null = null;
  let topLen = 0;
  for (const [el, len] of counts) if (len > topLen) { top = el; topLen = len; }
  return topLen >= MIN_ARTICLE_CHARS * 2 ? top : null;
}

/** Chrome renders .txt/.md/.csv (and other text/*) files as a single <pre>. */
export function isPlainTextDocument(doc: Document = document): boolean {
  const type = doc.contentType;
  return type.startsWith("text/") && type !== "text/html" && !type.includes("xml") && !!doc.body?.querySelector(":scope > pre");
}

export function isPdfDocument(doc: Document = document): boolean {
  return doc.contentType === "application/pdf";
}

/** URL of the largest PDF embedded in the page (<embed>, <object>, <iframe>), if any. */
export function findEmbeddedPdf(doc: Document = document): string | null {
  let best: string | null = null;
  let bestArea = 200 * 200;
  for (const el of deepQueryAll("embed, object, iframe", doc)) {
    const src = el.getAttribute("src") || el.getAttribute("data") || "";
    const isPdf = el.getAttribute("type") === "application/pdf" || /\.pdf($|[?#])/i.test(src);
    if (!isPdf || !src || src === "about:blank") continue;
    const r = el.getBoundingClientRect();
    if (r.width * r.height > bestArea) {
      bestArea = r.width * r.height;
      best = new URL(src, doc.baseURI).href;
    }
  }
  return best;
}

/** A canvas covering much of the viewport suggests a canvas-rendered document (no DOM text). */
export function hasLargeCanvas(doc: Document = document): boolean {
  const viewport = window.innerWidth * window.innerHeight;
  return deepQueryAll("canvas", doc).some((c) => {
    const r = c.getBoundingClientRect();
    return r.width * r.height > viewport * 0.3;
  });
}

export class PageText {
  private chunks: Chunk[] = [];
  private blockCache = new Map<Element, boolean>();
  private visibleCache = new Map<Element, boolean>();

  /** Returns sentence texts, or null when the mode finds nothing to read. */
  extract(mode: ExtractMode, range?: Range | null): string[] | null {
    this.blockCache.clear();
    this.visibleCache.clear();
    let root: Node | null;
    let skip = SKIP_PAGE + ", " + SKIP_ALWAYS;
    if (mode === "selection") {
      if (!range || range.collapsed || !range.toString().trim()) return null;
      const c = range.commonAncestorContainer;
      root = c.nodeType === Node.ELEMENT_NODE ? c : c.parentElement;
      skip = SKIP_ALWAYS;
    } else {
      range = null;
      if (mode === "plain") skip = SKIP_ALWAYS;
      root = mode === "article" ? findArticle() : document.body;
    }
    if (!root) return null;
    this.chunks = this.collect(root, range ?? null, skip).flatMap((p) => this.split(p));
    return this.chunks.length ? this.chunks.map((c) => c.text) : null;
  }

  /** DOM range covering a sentence, or null if the page changed underneath us. */
  rangeFor(index: number): Range | null {
    const chunk = this.chunks[index];
    if (!chunk) return null;
    try {
      const start = position(chunk.pieces, chunk.start);
      let end = position(chunk.pieces, chunk.end);
      // A range can't cross into another shadow tree: stop at the last piece in the start's tree.
      const rootOf = (n: Node) => n.getRootNode();
      if (rootOf(start[0]) !== rootOf(end[0])) {
        const same = chunk.pieces.filter((p) => p.offset < chunk.end && rootOf(p.node) === rootOf(start[0]));
        const last = same[same.length - 1]!;
        end = [last.node, last.end];
      }
      const range = document.createRange();
      range.setStart(...start);
      range.setEnd(...end);
      return range;
    } catch {
      return null;
    }
  }

  private isVisible(el: Element): boolean {
    let v = this.visibleCache.get(el);
    if (v === undefined) {
      v = el.checkVisibility({ checkVisibilityCSS: true });
      this.visibleCache.set(el, v);
    }
    return v;
  }

  private blockOf(el: Element): Element {
    let cur: Element | null = el;
    while (cur && cur !== document.body) {
      let isBlock = this.blockCache.get(cur);
      if (isBlock === undefined) {
        const display = getComputedStyle(cur).display;
        isBlock = !display.startsWith("inline") && display !== "contents";
        this.blockCache.set(cur, isBlock);
      }
      if (isBlock) return cur;
      cur = composedParent(cur);
    }
    return document.body;
  }

  /** Text nodes in rendered order, descending into shadow roots and slots, pruning skipped subtrees. */
  private walk(node: Node, skip: string, visit: (t: Text) => void): void {
    if (node.nodeType === Node.TEXT_NODE) return visit(node as Text);
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      if (el.matches(skip)) return;
      if (el.shadowRoot) {
        for (let c = el.shadowRoot.firstChild; c; c = c.nextSibling) this.walk(c, skip, visit);
        return;
      }
      if (el.localName === "slot") {
        const assigned = (el as HTMLSlotElement).assignedNodes();
        if (assigned.length) {
          for (const n of assigned) this.walk(n, skip, visit);
          return;
        }
      }
    } else if (node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
      return;
    }
    for (let c = node.firstChild; c; c = c.nextSibling) this.walk(c, skip, visit);
  }

  private collect(root: Node, range: Range | null, skip: string): Paragraph[] {
    const paragraphs: Paragraph[] = [];
    let current: Paragraph | null = null;
    this.walk(root, skip, (node) => {
      if (range && !range.intersectsNode(node)) return;
      // The light-DOM parent has a box (a <slot> is display: contents and would look invisible).
      const parent = node.parentElement ?? composedParent(node);
      if (!parent || !node.data.trim() || !this.isVisible(parent)) return;
      let start = 0;
      let end = node.data.length;
      if (range && node === range.startContainer) start = range.startOffset;
      if (range && node === range.endContainer) end = range.endOffset;
      if (start >= end) return;
      const block = this.blockOf(parent);
      if (!current || current.block !== block) {
        current = { block, pieces: [], text: "" };
        paragraphs.push(current);
      }
      current.pieces.push({ node, start, end, offset: current.text.length });
      current.text += node.data.slice(start, end);
    });
    // Lone "Advertisement" labels left behind by ad slots.
    return paragraphs.filter((p) => !/^\s*(advertisement|sponsored)\s*$/i.test(p.text));
  }

  /** One chunk per sentence: matches the sentence list in the widget and keeps audio requests short. */
  private split(par: Paragraph): Chunk[] {
    const out: Chunk[] = [];
    // A single line break (source formatting, hard-wrapped text) is not a sentence end; a blank
    // line is. Same-length replacement keeps offsets aligned with the DOM text.
    const text = par.text.replace(/(?<!\n)\n(?!\n)/g, " ");
    for (const [start, end] of sentenceSpans(text, document.documentElement.lang || undefined)) {
      const segment = text.slice(start, end);
      const clean = segment.replace(/\s+/g, " ").trim();
      if (/[\p{L}\p{N}]/u.test(clean)) {
        out.push({ text: clean, pieces: par.pieces, start, end: start + segment.trimEnd().length });
      }
    }
    return out;
  }
}

function position(pieces: Piece[], offset: number): [Node, number] {
  for (const p of pieces) {
    const len = p.end - p.start;
    if (offset <= p.offset + len) return [p.node, p.start + (offset - p.offset)];
  }
  const last = pieces[pieces.length - 1]!; // a chunk always has at least one piece
  return [last.node, last.end];
}
