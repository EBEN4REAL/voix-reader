// End-to-end check that Voix reads every kind of document: PDFs (text, scanned,
// embedded, local file), plain text, web components, iframes, canvas pages
// (OCR) and Google Docs. Needs the Kokoro server on :8899, e2e/site served on
// :8766 and e2e/site/other on :8767. See README.md ("End-to-end test").
import { mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";

const extDir = new URL("../.output/chrome-mv3", import.meta.url).pathname;
const docsDir = new URL("./site/docs", import.meta.url).pathname;
const SHOTS = new URL("./screenshots", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const executablePath = process.env.CHROME_PATH;
if (!executablePath) throw new Error("Set CHROME_PATH to a Chrome for Testing binary (see README).");
const SITE = "http://127.0.0.1:8766/docs";
const only = process.argv[2];

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  enableExtensions: [extDir],
  pipe: true,
  args: ["--autoplay-policy=no-user-gesture-required", "--window-size=1366,900"],
  defaultViewport: { width: 1366, height: 900 },
});
const sw = await (await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("background.js"))).worker();
await sw.evaluate(() => chrome.storage.local.set({
  "voix:serverUrl": "http://127.0.0.1:8899", "voix:privacyAccepted": true, "voix:neverSites": [],
}));
const page = await browser.newPage();

const shadow = (fn, ...args) => page.evaluate((src, args) => {
  const root = document.querySelector("voix-widget")?.shadowRoot;
  return new Function("root", "args", src)(root, args);
}, `return (${fn})(root, args)`, args);
const widgetText = () => shadow((root) => root?.textContent ?? "").catch(() => "");
const sentences = () => shadow((root) => [...(root?.querySelectorAll(".voix-sentence") ?? [])].map((b) => b.textContent.replace(/^\d+\./, "")));
const click = (label) => shadow((root, [label]) => {
  const b = [...(root?.querySelectorAll("button") ?? [])].find((x) => x.getAttribute("aria-label") === label || x.textContent.trim() === label);
  if (!b) throw new Error(`button not found: ${label}`);
  b.click();
}, label);
const waitFor = async (pred, timeout) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await pred().catch(() => false)) return true;
    await sleep(300);
  }
  return false;
};
const waitText = (text, timeout = 20000) => waitFor(async () => (await widgetText()).includes(text), timeout);
// What the toolbar icon does: message the page, injecting the content script first if needed.
const toggle = () => sw.evaluate(async () => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "voix:toggle" });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["/content-scripts/content.js"] });
    await chrome.tabs.sendMessage(tab.id, { type: "voix:toggle" });
  }
  return true;
}).catch((e) => e.message);

async function readCase(name, url, { expect = [], reject = [], timeout = 30000, before, after } = {}) {
  if (only && !name.toLowerCase().includes(only)) return;
  try {
    await page.goto(url, { waitUntil: "load" });
    await sleep(800);
    if (before) await before();
    else {
      const t = await toggle();
      if (t !== true) return check(`${name}: open`, false, String(t));
    }
    const playing = await waitText("Pause", timeout);
    const list = (await sentences()).join(" | ");
    const failed = !playing && (await shadow((root) =>
      [...(root?.querySelectorAll(".voix-meta, .voix-notice, .voix-card") ?? [])].map((e) => e.innerText).join(" / ")));
    check(`${name}: reads aloud`, playing, playing ? `${(await sentences()).length} sentences` : failed?.slice(0, 160));
    for (const e of expect) check(`${name}: contains "${e.slice(0, 50)}"`, list.includes(e));
    for (const r of reject) check(`${name}: skips "${r}"`, !new RegExp(r).test(list));
    if (after) await after(list);
    await page.screenshot({ path: `${SHOTS}/doc-${name.replace(/\W+/g, "-")}.png` });
    await toggle();
    await sleep(300);
  } catch (e) {
    check(`${name}: unexpected error`, false, e.message);
  }
}

try {
  await readCase("PDF prompt", `${SITE}/report.pdf`, {
    before: async () => {
      const prompted = await waitText("Listen to this document?", 8000);
      check("PDF prompt: offers to read the PDF", prompted, (await widgetText()).match(/About \d+ min/)?.[0]);
      await click("Listen");
    },
    expect: ["Listening to documents is becoming a normal part of work.", "Dr. Rivera, who led the study, put it simply."],
    reject: ["file://", "\\b\\d+/4\\b", "\\d{1,2}/\\d{1,2}/\\d{2,4}, \\d"],
    after: async (list) => {
      check("PDF prompt: running title only read once", (list.match(/Annual Listening Report/g) ?? []).length === 1);
      check("PDF prompt: first body sentence kept", list.includes("People review reports while commuting, and they catch up on research while cooking dinner."));
    },
  });
  await readCase("scanned PDF (OCR)", `${SITE}/scan.pdf`, {
    expect: ["quarterly meeting moves to Thursday"], timeout: 90000,
  });
  await readCase("embedded PDF", `${SITE}/embedded.html`, { expect: ["Listening to documents is becoming a normal part of work."] });
  await readCase("local PDF file", `file://${docsDir}/report.pdf`, { expect: ["Listening to documents"] });
  await readCase("plain text file", `${SITE}/notes.txt`, {
    expect: ["Lines in a text file are often wrapped by hand at about seventy characters, and the reader should join them back into sentences."],
  });
  await readCase("web components", `${SITE}/components.html`, {
    expect: ["Inside the Shadow", "Voix walks into shadow roots"], reject: ["Home Products"],
    after: async () => check("web components: highlights inside the shadow root",
      await page.evaluate(() => { const h = CSS.highlights.get("voix-current"); return !!h && [...h][0].toString().length > 0; })),
  });
  await readCase("iframe document", `${SITE}/framed.html`, {
    expect: ["This document is shown inside an iframe"], reject: ["Viewer · Share"],
    after: async () => {
      const frame = page.frames().find((f) => f.url().includes("frame-doc"));
      check("iframe document: highlights inside the frame",
        !!frame && await waitFor(() => frame.evaluate(() => CSS.highlights.has("voix-current")), 5000));
    },
  });
  await readCase("canvas page (OCR)", `${SITE}/canvas.html`, {
    before: async () => {
      await toggle();
      check("canvas page: offers manual reading", await waitText("We couldn't find an article here", 5000));
      await click("Read the whole page");
    },
    expect: ["drawn on a canvas"], timeout: 60000,
  });
  await readCase("Google Doc", "https://docs.google.com/document/d/14YBYKgk-uSfjfwpKFlp_omgUq5hwMVazy_M965s_1KA/edit", {
    expect: ["Chromium Design Doc Template"], timeout: 45000,
  });
  await readCase("Google Slides", "https://docs.google.com/presentation/d/1f38v02TDF-Zv93-BvWEafol5pNPgQADbL3BgsiWCJx8/edit", {
    expect: ["The Classroom and Google Apps"], timeout: 45000,
  });
  await readCase("Google Sheets", "https://docs.google.com/spreadsheets/d/1l2NPtwmwxoGLt6x16aKmOap4acfF-9fkNyrPmZ4UYCM/edit?gid=0", {
    expect: ["Minecraft Versions, Created December 23, 2013"], timeout: 45000,
  });
  await readCase("article (regression)", "http://127.0.0.1:8766/article.html", { expect: ["The Quiet Return of the Long Read"] });
} finally {
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
