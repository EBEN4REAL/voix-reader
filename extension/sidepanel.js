// Side panel: fetches audio from the Kokoro server sentence by sentence and
// plays it, prefetching ahead so playback is gapless.
const DEFAULT_SERVER = "http://127.0.0.1:8880";
const PREFETCH = 2;

const $ = (id) => document.getElementById(id);
const ui = {
  play: $("play"), stop: $("stop"), prev: $("prev"), next: $("next"),
  voice: $("voice"), speed: $("speed"), speedValue: $("speed-value"),
  status: $("status"), chunks: $("chunks"), server: $("server"),
  apiKey: $("api-key"), saveServer: $("save-server"), serverStatus: $("server-status"),
};

const audio = new Audio();
const cache = new Map(); // `${voice}|${text}` -> Promise<blob URL>
const state = { server: DEFAULT_SERVER, apiKey: "", tabId: null, chunks: [], index: 0, active: false, paused: false, session: 0 };

// ---------- server ----------

function authHeaders() {
  return state.apiKey ? { Authorization: `Bearer ${state.apiKey}` } : {};
}

async function checkServer() {
  try {
    const res = await fetch(`${state.server}/voices`, { headers: authHeaders() });
    if (res.status === 401) {
      ui.serverStatus.className = "dot down";
      return setStatus("Server needs an API key: add it under Settings.", true);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { voices } = await res.json();
    ui.serverStatus.className = "dot ok";
    ui.serverStatus.title = `Connected to ${state.server}`;
    fillVoices(voices);
  } catch {
    ui.serverStatus.className = "dot down";
    ui.serverStatus.title = `Cannot reach ${state.server}`;
    setStatus(`Cannot reach the Kokoro server at ${state.server}. Is it running?`, true);
  }
}

function fillVoices(voices) {
  const saved = ui.voice.value || localStorage.getItem("voice") || "af_heart";
  ui.voice.replaceChildren(...voices.map((v) => new Option(v, v)));
  ui.voice.value = voices.includes(saved) ? saved : voices[0];
}

function getAudio(i) {
  const text = state.chunks[i];
  const voice = ui.voice.value;
  const key = `${voice}|${text}`;
  if (!cache.has(key)) {
    const p = fetch(`${state.server}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      // WAV: no encoding cost, size doesn't matter on localhost.
      body: JSON.stringify({ input: text, voice, response_format: "wav" }),
    }).then(async (res) => {
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `HTTP ${res.status}`);
      return URL.createObjectURL(await res.blob());
    });
    p.catch(() => cache.delete(key)); // allow retry
    cache.set(key, p);
  }
  return cache.get(key);
}

function clearCache() {
  for (const p of cache.values()) p.then(URL.revokeObjectURL, () => {});
  cache.clear();
}

// ---------- page ----------

function sendToTab(msg) {
  if (state.tabId == null) return Promise.resolve();
  return chrome.tabs.sendMessage(state.tabId, msg).catch(() => {}); // tab gone or navigated
}

async function extractFromActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab.");
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  } catch {
    throw new Error("Chrome doesn't allow reading this page (e.g. chrome:// pages or the Web Store).");
  }
  const result = await chrome.tabs.sendMessage(tab.id, { type: "kokoro:extract" });
  return { tabId: tab.id, ...result };
}

// ---------- playback ----------

async function playChunk(i) {
  const session = state.session;
  if (i < 0) i = 0;
  if (i >= state.chunks.length) return finish();
  state.index = i;
  render();
  sendToTab({ type: "kokoro:highlight", index: i });

  let url;
  try {
    url = await getAudio(i);
  } catch (e) {
    if (session === state.session) { setStatus(`Error: ${e.message}`, true); stop(); }
    return;
  }
  if (session !== state.session) return; // user skipped or stopped meanwhile

  for (let k = 1; k <= PREFETCH; k++) if (i + k < state.chunks.length) getAudio(i + k).catch(() => {});

  audio.src = url;
  audio.defaultPlaybackRate = audio.playbackRate = Number(ui.speed.value);
  if (!state.paused) await audio.play().catch(() => {});
}

audio.addEventListener("ended", () => {
  if (state.active) playChunk(state.index + 1);
});

function jump(i) {
  state.session++;
  state.paused = false;
  playChunk(i);
}

async function start() {
  stop();
  setStatus("Reading page...");
  try {
    const { tabId, chunks, source, title } = await extractFromActiveTab();
    if (!chunks.length) throw new Error("No readable text found on this page.");
    state.tabId = tabId;
    state.chunks = chunks;
    state.active = true;
    setStatus(`${source === "selection" ? "Selection" : title}: ${chunks.length} sentences`);
    renderList();
    jump(0);
  } catch (e) {
    setStatus(e.message, true);
  }
}

function togglePause() {
  state.paused = !state.paused;
  if (state.paused) audio.pause();
  else if (audio.src) audio.play().catch(() => {});
  render();
}

function stop() {
  state.session++;
  state.active = false;
  state.paused = false;
  audio.pause();
  audio.removeAttribute("src");
  sendToTab({ type: "kokoro:clear" });
  clearCache();
  render();
}

function finish() {
  const n = state.chunks.length;
  stop();
  setStatus(`Finished (${n} sentences).`);
}

// ---------- UI ----------

function setStatus(text, isError = false) {
  ui.status.textContent = text;
  ui.status.classList.toggle("error", isError);
}

function renderList() {
  ui.chunks.replaceChildren(...state.chunks.map((text, i) => {
    const li = document.createElement("li");
    li.textContent = text;
    li.addEventListener("click", () => { if (state.active) jump(i); });
    return li;
  }));
}

function render() {
  ui.play.textContent = !state.active ? "▶ Read" : state.paused ? "▶ Resume" : "⏸ Pause";
  ui.stop.disabled = ui.prev.disabled = ui.next.disabled = !state.active;
  [...ui.chunks.children].forEach((li, i) => li.classList.toggle("current", state.active && i === state.index));
  ui.chunks.children[state.index]?.scrollIntoView({ block: "nearest" });
}

ui.play.addEventListener("click", () => (state.active ? togglePause() : start()));
ui.stop.addEventListener("click", () => { stop(); setStatus("Stopped."); });
ui.prev.addEventListener("click", () => jump(state.index - 1));
ui.next.addEventListener("click", () => jump(state.index + 1));
ui.speed.addEventListener("input", () => {
  const rate = Number(ui.speed.value);
  ui.speedValue.textContent = `${rate.toFixed(1)}×`;
  audio.playbackRate = audio.defaultPlaybackRate = rate;
  localStorage.setItem("speed", rate);
});
ui.voice.addEventListener("change", () => localStorage.setItem("voice", ui.voice.value));
ui.saveServer.addEventListener("click", async () => {
  state.server = (ui.server.value.trim() || DEFAULT_SERVER).replace(/\/+$/, "");
  ui.server.value = state.server;
  state.apiKey = ui.apiKey.value.trim();
  await chrome.storage.local.set({ server: state.server, apiKey: state.apiKey });
  setStatus("Server saved.");
  checkServer();
});

// Stop if the page being read navigates away or its tab closes.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (state.active && tabId === state.tabId && info.status === "loading") { stop(); setStatus("Page changed; stopped."); }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  if (state.active && tabId === state.tabId) { stop(); setStatus("Tab closed; stopped."); }
});

(async function init() {
  const { server, apiKey } = await chrome.storage.local.get(["server", "apiKey"]);
  state.server = server || DEFAULT_SERVER;
  state.apiKey = apiKey || "";
  ui.server.value = state.server;
  ui.apiKey.value = state.apiKey;
  const speed = localStorage.getItem("speed");
  if (speed) { ui.speed.value = speed; ui.speedValue.textContent = `${Number(speed).toFixed(1)}×`; }
  render();
  checkServer();
})();
