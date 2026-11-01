// Plus Jakarta Sans is bundled with the extension. @font-face rules inside a
// Shadow DOM are ignored, so the font is registered on the document; loading
// it from bytes (not a URL) also sidesteps the host page's font-src CSP.

export const FONT_FAMILY = "Voix Jakarta";

export async function loadVoixFont(url: string): Promise<void> {
  if ([...document.fonts].some((f) => f.family.replace(/"/g, "") === FONT_FAMILY)) return;
  try {
    const bytes = await (await fetch(url)).arrayBuffer();
    const face = new FontFace(FONT_FAMILY, bytes, { weight: "200 800", display: "swap" });
    document.fonts.add(await face.load());
  } catch {
    // system-ui fallback in the CSS stack is fine.
  }
}
