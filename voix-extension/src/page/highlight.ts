// On-page highlight of the sentence being read, via the CSS Custom Highlight
// API: no DOM changes to the page text, only a named highlight and a style rule
// (added to the document, and to any shadow root the sentence lives in).

const NAME = "voix-current";
const RULE = `::highlight(${NAME}) { background-color: #CDEFFF; color: #062A3D; }`;
const styled = new WeakSet<Document | ShadowRoot>();

function ensureStyle(root: Node) {
  const scope = root instanceof ShadowRoot ? root : document;
  if (styled.has(scope)) return;
  const style = document.createElement("style");
  style.textContent = RULE;
  (scope instanceof ShadowRoot ? scope : document.documentElement).appendChild(style);
  styled.add(scope);
}

export function highlightRange(range: Range | null): void {
  if (!range || typeof CSS === "undefined" || !("highlights" in CSS)) return clearHighlight();
  ensureStyle(range.startContainer.getRootNode());
  CSS.highlights.set(NAME, new Highlight(range));
}

export function clearHighlight(): void {
  if (typeof CSS !== "undefined" && "highlights" in CSS) CSS.highlights.delete(NAME);
}

export function scrollToRange(range: Range | null): void {
  if (!range) return;
  const rect = range.getBoundingClientRect();
  if (!rect.height) return;
  const margin = 96;
  if (rect.top >= margin && rect.bottom <= window.innerHeight - margin) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // scrollIntoView also scrolls inner scroll containers (apps that scroll a div, not the window).
  const el = range.startContainer.nodeType === Node.ELEMENT_NODE
    ? (range.startContainer as Element)
    : range.startContainer.parentElement;
  el?.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
}
