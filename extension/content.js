// Injected into the page on demand. Extracts readable text as sentence-sized
// chunks and highlights the chunk currently being spoken.
(() => {
  // Re-injection (e.g. after the extension reloads) replaces the old instance.
  try { window.__kokoroReader?.dispose(); } catch {}

  const MAX_CHUNK = 300; // characters; fits one Kokoro pass (~510 phonemes)
  // Page chrome and non-prose. A user selection only skips the last group.
  const SKIP_PAGE = "nav, aside, footer, button, select, textarea, pre, code, sup, [aria-hidden='true'], ";
  const SKIP_ALWAYS = "script, style, noscript, svg, math, [hidden]";
  const HIGHLIGHT = "kokoro-current";

  const style = document.createElement("style");
  style.textContent = `::highlight(${HIGHLIGHT}) { background: #ffe066; color: #000; }`;
  document.documentElement.appendChild(style);

  let chunks = []; // { text, pieces, start, end }
  let skip = SKIP_PAGE + SKIP_ALWAYS;
  const blockCache = new Map();
  const visibleCache = new Map();

  function paragraphTextLength(el) {
    let n = 0;
    for (const p of el.querySelectorAll("p")) n += p.textContent.length;
    return n;
  }

  // Prefer the <article>/<main> with the most paragraph text; else the whole body.
  function findRoot() {
    let best = document.body;
    let bestLen = 0;
    for (const el of document.querySelectorAll("article, main, [role='main']")) {
      const len = paragraphTextLength(el);
      if (len > bestLen) { best = el; bestLen = len; }
    }
    return bestLen >= 500 ? best : document.body;
  }

  function isVisible(el) {
    if (!visibleCache.has(el)) {
      visibleCache.set(el, el.checkVisibility({ checkVisibilityCSS: true }) && !el.closest(skip));
    }
    return visibleCache.get(el);
  }

  // Nearest ancestor that is not inline: text in the same block reads as one paragraph.
  function blockOf(el) {
    let cur = el;
    while (cur && cur !== document.body) {
      if (!blockCache.has(cur)) {
        blockCache.set(cur, !getComputedStyle(cur).display.startsWith("inline"));
      }
      if (blockCache.get(cur)) return cur;
      cur = cur.parentElement;
    }
    return document.body;
  }

  // Collect visible text as { node, start, end } pieces, grouped into paragraphs.
  function collectParagraphs(root, range) {
    const paragraphs = [];
    let current = null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (range && !range.intersectsNode(node)) continue;
      const parent = node.parentElement;
      if (!parent || !node.data.trim() || !isVisible(parent)) continue;
      let start = 0;
      let end = node.data.length;
      if (range && node === range.startContainer) start = range.startOffset;
      if (range && node === range.endContainer) end = range.endOffset;
      if (start >= end) continue;
      const block = blockOf(parent);
      if (!current || current.block !== block) {
        current = { block, pieces: [], text: "" };
        paragraphs.push(current);
      }
      current.pieces.push({ node, start, end, offset: current.text.length });
      current.text += node.data.slice(start, end);
    }
    return paragraphs;
  }

  function splitParagraph(par) {
    const out = [];
    const segmenter = new Intl.Segmenter(document.documentElement.lang || undefined, { granularity: "sentence" });
    let chunk = null;
    const flush = () => {
      if (!chunk) return;
      const text = par.text.slice(chunk.start, chunk.end).replace(/\s+/g, " ").trim();
      if (/[\p{L}\p{N}]/u.test(text)) out.push({ text, pieces: par.pieces, start: chunk.start, end: chunk.end });
      chunk = null;
    };
    for (const { segment, index } of segmenter.segment(par.text)) {
      const end = index + segment.length;
      if (chunk && end - chunk.start > MAX_CHUNK) flush();
      if (!chunk) chunk = { start: index, end };
      else chunk.end = end;
    }
    flush();
    return out;
  }

  function extract() {
    blockCache.clear();
    visibleCache.clear();
    const sel = window.getSelection();
    const range = sel && !sel.isCollapsed && sel.toString().trim() ? sel.getRangeAt(0) : null;
    skip = range ? SKIP_ALWAYS : SKIP_PAGE + SKIP_ALWAYS;
    const root = range
      ? (range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
          ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement)
      : findRoot();
    chunks = collectParagraphs(root, range).flatMap(splitParagraph);
    return { title: document.title, source: range ? "selection" : "page", chunks: chunks.map((c) => c.text) };
  }

  // Convert a paragraph offset back to a DOM position.
  function domPosition(pieces, offset) {
    for (const p of pieces) {
      const len = p.end - p.start;
      if (offset <= p.offset + len) return [p.node, p.start + (offset - p.offset)];
    }
    const last = pieces[pieces.length - 1];
    return [last.node, last.end];
  }

  function highlight(index) {
    const chunk = chunks[index];
    if (!chunk) return clear();
    try {
      const range = document.createRange();
      range.setStart(...domPosition(chunk.pieces, chunk.start));
      range.setEnd(...domPosition(chunk.pieces, chunk.end));
      CSS.highlights.set(HIGHLIGHT, new Highlight(range));
      const rect = range.getBoundingClientRect();
      if (rect.top < 80 || rect.bottom > window.innerHeight - 80) {
        window.scrollBy({ top: rect.top - window.innerHeight / 3, behavior: "smooth" });
      }
    } catch {
      // The page changed under us (e.g. dynamic content); keep reading without highlight.
      clear();
    }
  }

  function clear() {
    CSS.highlights.delete(HIGHLIGHT);
  }

  function onMessage(msg, _sender, sendResponse) {
    if (msg.type === "kokoro:extract") sendResponse(extract());
    else if (msg.type === "kokoro:highlight") { highlight(msg.index); sendResponse(true); }
    else if (msg.type === "kokoro:clear") { clear(); sendResponse(true); }
  }
  chrome.runtime.onMessage.addListener(onMessage);

  window.__kokoroReader = {
    extract, highlight, clear,
    dispose() {
      clear();
      style.remove();
      chrome.runtime.onMessage.removeListener(onMessage);
    },
  };
})();
