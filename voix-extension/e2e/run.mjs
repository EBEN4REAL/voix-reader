// End-to-end check of the built Voix extension in Chrome for Testing, against
// a real Kokoro server on :8899 and the test pages in e2e/site served on :8766.
// See README.md ("End-to-end test") for how to run it.
import puppeteer from "puppeteer-core";

const extDir = new URL("../.output/chrome-mv3", import.meta.url).pathname;
const executablePath = process.env.CHROME_PATH;
if (!executablePath) throw new Error("Set CHROME_PATH to a Chrome for Testing binary (see README).");
const SITE = "http://127.0.0.1:8766";
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const SHOTS = new URL("./screenshots", import.meta.url).pathname;
await import("node:fs").then((fs) => fs.mkdirSync(SHOTS, { recursive: true }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  enableExtensions: [extDir],
  pipe: true,
  args: ["--autoplay-policy=no-user-gesture-required", "--window-size=1366,900"],
  defaultViewport: { width: 1366, height: 900 },
});

const swTarget = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("background.js"));
const sw = await swTarget.worker();
await sw.evaluate(() => chrome.storage.local.set({ "voix:serverUrl": "http://127.0.0.1:8899", "voix:privacyAccepted": false }));

const page = await browser.newPage();
const widgetText = () => page.evaluate(() => document.querySelector("voix-widget")?.shadowRoot?.textContent ?? "");
const click = (label) => page.evaluate((label) => {
  const root = document.querySelector("voix-widget")?.shadowRoot;
  const btn = [...(root?.querySelectorAll("button") ?? [])].find(
    (b) => b.getAttribute("aria-label") === label || b.textContent.trim() === label);
  if (!btn) throw new Error(`button not found: ${label}`);
  btn.click();
}, label);
const waitForText = async (text, timeout = 30000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if ((await widgetText()).includes(text)) return true;
    await sleep(250);
  }
  return false;
};
const toggle = () => sw.evaluate(async () => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  await chrome.tabs.sendMessage(tab.id, { type: "voix:toggle" });
});

try {
  await page.goto(`${SITE}/article.html`);
  check("prompt card appears on an article", await waitForText("Listen to this article?", 6000));
  const prompt = await widgetText();
  check("prompt card shows listening time", /About \d+ min · Natural voice/.test(prompt), prompt.match(/About \d+ min/)?.[0]);
  await page.screenshot({ path: SHOTS + "/e2e-1-prompt.png" });

  await click("Listen");
  check("privacy notice before first listen", await waitForText("Before you listen", 3000));
  await click("Got it");
  check("panel opens and prepares voice", await waitForText("Preparing voice", 5000) || await waitForText("Pause", 1000));
  check("first audio plays (Pause shown)", await waitForText("Pause", 30000));

  const sentences = await page.evaluate(() =>
    [...document.querySelector("voix-widget").shadowRoot.querySelectorAll(".voix-sentence")].map((b) => b.textContent));
  check("starts with the article title", sentences[0]?.includes("The Quiet Return of the Long Read"), `${sentences.length} sentences`);
  const joined = sentences.join(" ");
  check("skips nav, advert and footer", !/Subscribe now|Buy our product|Copyright Newsroom|ADVERTISEMENT/.test(joined));

  const hl = await page.evaluate(() => CSS.highlights.get("voix-current") ? [...CSS.highlights.get("voix-current")][0].toString() : null);
  check("highlights the current sentence on the page", !!hl, hl?.slice(0, 40));

  check("advances to sentence 2 when audio ends", await waitForText("Sentence 2 of", 30000));
  await page.screenshot({ path: SHOTS + "/e2e-2-playing.png" });

  await click("Faster");
  check("speed changes to 1.1x", await waitForText("1.1× speed", 2000));

  await click("Pause");
  check("pause shows Resume", await waitForText("Resume", 2000));
  await click("Resume");
  check("resume continues", await waitForText("Pause", 5000));

  await click("Minimise reader");
  check("minimise shows the pill", await waitForText("Voix · Reading", 2000));
  const before = (await widgetText()).match(/Sentence (\d+) of/)?.[1];
  const advanced = await (async () => {
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      const now = (await widgetText()).match(/Sentence (\d+) of/)?.[1];
      if (now && now !== before) return true;
      await sleep(300);
    }
    return false;
  })();
  check("playback continues while minimised", advanced);
  await page.screenshot({ path: SHOTS + "/e2e-3-pill.png" });
  await click("Expand reader");

  await sw.evaluate(() => chrome.storage.local.set({ "voix:serverUrl": "http://127.0.0.1:1" })); // unreachable
  await click("Next sentence");
  const fellBack = await waitForText("Device voice", 15000);
  const errored = !fellBack && (await waitForText("Voix stopped", 1000));
  check("voice service failure is handled visibly", fellBack || errored, fellBack ? "device-voice fallback" : errored ? "error state (no device voices in headless)" : "");
  await page.screenshot({ path: SHOTS + "/e2e-4-fallback.png" });
  await sw.evaluate(() => chrome.storage.local.set({ "voix:serverUrl": "http://127.0.0.1:8899" }));

  await toggle();
  await sleep(500);
  check("toolbar toggle closes the widget", !(await widgetText()).includes("Sentence"));
  check("closing clears the page highlight", await page.evaluate(() => !CSS.highlights.has("voix-current")));

  await page.goto(`${SITE}/plain.html`);
  await sleep(2500);
  check("no prompt on a non-article page", !(await widgetText()).includes("Listen to this article?"));
  await toggle();
  check("no-article card when opened on a non-article", await waitForText("We couldn't find an article here", 3000));
  await click("Read the whole page");
  check("read the whole page starts reading", await waitForText("Sentence 1 of", 5000));
  await page.screenshot({ path: SHOTS + "/e2e-5-plain.png" });
} catch (e) {
  check("unexpected error", false, e.message);
} finally {
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
