// Generates Chrome Web Store images into store/: the 128x128 store icon,
// 1280x800 screenshots of the widget (from the dev page), the 440x280 promo
// tile and the 1400x560 marquee.
// Needs a normal build (npm run build) and Google Chrome; set CHROME_PATH if
// Chrome isn't in the default macOS location.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";

const root = new URL("..", import.meta.url).pathname;
const outDir = join(root, "store");
const chrome = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 8790;
mkdirSync(outDir, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), "voix-shots-"));

// Store icon: 96x96 artwork inside 128x128 with 16px transparent padding (Chrome Web Store guideline).
const mark = readFileSync(join(root, "assets/icon/voix-128.svg"), "utf8").replace(/<svg[^>]*>|<\/svg>/g, "");
const icon = `<svg width="128" height="128" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
  <svg x="16" y="16" width="96" height="96" viewBox="0 0 32 32">${mark}</svg></svg>`;
writeFileSync(join(outDir, "store-icon-128.png"), new Resvg(icon).render().asPng());
console.log("store/store-icon-128.png");

function shot(url, file, [w, h], budget = 3000) {
  execFileSync(chrome, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-prefers-reduced-motion",
    "--allow-file-access-from-files", `--user-data-dir=${profile}`, `--window-size=${w},${h}`,
    `--virtual-time-budget=${budget}`, `--screenshot=${join(outDir, file)}`, url,
  ], { stdio: "ignore" });
  console.log(`store/${file}`);
}

const server = spawn("python3", ["-m", "http.server", String(port)], { cwd: join(root, ".output/chrome-mv3"), stdio: "ignore" });
try {
  await new Promise((r) => setTimeout(r, 800));
  const dev = (state) => `http://127.0.0.1:${port}/dev.html#state=${state}&clean`;
  shot(dev(12), "screenshot-1-reading.png", [1280, 800], 2200);
  shot(dev(2), "screenshot-2-prompt.png", [1280, 800]);
  shot(dev(7), "screenshot-3-minimised.png", [1280, 800], 2200);

  const font = join(root, "public/fonts/PlusJakartaSans-Variable.woff2");
  const tile = join(profile, "tile.html");
  writeFileSync(tile, `<!doctype html><html><head><style>
    @font-face { font-family: Jakarta; src: url("file://${font}"); font-weight: 200 800; }
    body { margin: 0; width: 440px; height: 280px; display: grid; place-items: center;
      background: linear-gradient(135deg, #FFFFFF 0%, #E8F8FF 100%); font-family: Jakarta, sans-serif; }
    .wrap { display: flex; flex-direction: column; align-items: center; gap: 14px; }
    .brand { display: flex; align-items: center; gap: 16px; }
    .name { font-size: 56px; font-weight: 700; color: #062A3D; letter-spacing: -1px; }
    .tag { font-size: 19px; font-weight: 500; color: #4A6578; }
  </style></head><body><div class="wrap">
    <div class="brand">
      <svg width="76" height="76" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#00BFFF"/>
        <path d="M8.5 9.5L16 23.5L23.5 9.5" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
      <span class="name">Voix</span>
    </div>
    <div class="tag">Listen to any article, in a natural voice.</div>
  </div></body></html>`);
  shot(`file://${tile}`, "promo-tile-440x280.png", [440, 280], 500);

  // Marquee: brand on the left, the reader panel (cropped from screenshot 1) on the right.
  const marquee = join(profile, "marquee.html");
  const reading = join(outDir, "screenshot-1-reading.png");
  writeFileSync(marquee, `<!doctype html><html><head><style>
    @font-face { font-family: Jakarta; src: url("file://${font}"); font-weight: 200 800; }
    body { margin: 0; width: 1400px; height: 560px; overflow: hidden; font-family: Jakarta, sans-serif;
      background: linear-gradient(120deg, #FFFFFF 0%, #FFFFFF 45%, #E8F8FF 100%); position: relative; }
    .copy { position: absolute; left: 110px; top: 50%; transform: translateY(-50%); width: 620px; }
    .brand { display: flex; align-items: center; gap: 22px; }
    .name { font-size: 92px; font-weight: 700; color: #062A3D; letter-spacing: -2px; }
    .tag { margin-top: 22px; font-size: 34px; font-weight: 600; color: #062A3D; line-height: 1.25; }
    .sub { margin-top: 16px; font-size: 22px; font-weight: 500; color: #4A6578; }
    .panel { position: absolute; right: 120px; top: 36px; width: 380px; height: 640px; border-radius: 24px;
      background: url("file://${reading}") -876px -136px no-repeat; transform: scale(0.76); transform-origin: top right;
      box-shadow: 0 28px 64px rgba(6,42,61,.20), 0 2px 8px rgba(6,42,61,.08); }
  </style></head><body>
    <div class="copy">
      <div class="brand">
        <svg width="110" height="110" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#00BFFF"/>
          <path d="M8.5 9.5L16 23.5L23.5 9.5" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
        <span class="name">Voix</span>
      </div>
      <div class="tag">Listen to any article, in a natural voice.</div>
      <div class="sub">Web pages, PDFs and Google Docs, read aloud with every sentence highlighted.</div>
    </div>
    <div class="panel"></div>
  </body></html>`);
  shot(`file://${marquee}`, "marquee-1400x560.png", [1400, 560], 500);
} finally {
  server.kill();
  rmSync(profile, { recursive: true, force: true });
}
