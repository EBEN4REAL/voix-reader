import { PageText } from "../src/page/extract";
import { clearHighlight, highlightRange, scrollToRange } from "../src/page/highlight";

// Runs inside iframes (documents embedded in other pages, e.g. Word for the web,
// online document viewers). No UI here: the top-frame widget asks the background
// to call window.__voixFrame through scripting.executeScript, which runs in this
// same isolated world.

export default defineContentScript({
  matches: ["<all_urls>"],
  allFrames: true,
  matchAboutBlank: true,
  runAt: "document_idle",

  main() {
    if (window.top === window) return;
    const page = new PageText();
    (window as unknown as { __voixFrame: unknown }).__voixFrame = {
      extract(mode: "article" | "page") {
        const texts = page.extract("article") ?? (mode === "page" ? page.extract("page") : null);
        return texts ? { texts, chars: texts.join(" ").length } : null;
      },
      highlight(index: number, highlight: boolean, scroll: boolean) {
        const range = page.rangeFor(index);
        if (highlight) highlightRange(range);
        else clearHighlight();
        if (scroll) scrollToRange(range);
      },
      clear: clearHighlight,
    };
  },
});
