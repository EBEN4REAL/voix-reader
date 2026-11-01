import { DEFAULT_PREFS, loadPrefs, savePrefs } from "../../src/storage";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const server = $<HTMLInputElement>("server");
const apiKey = $<HTMLInputElement>("api-key");
const status = $<HTMLParagraphElement>("status");
const never = $<HTMLUListElement>("never");
const neverEmpty = $<HTMLParagraphElement>("never-empty");

function setStatus(text: string, ok = true) {
  status.textContent = text;
  status.className = ok ? "ok" : "error";
}

async function renderNever() {
  const { neverSites } = await loadPrefs(["neverSites"]);
  never.replaceChildren(...neverSites.map((host) => {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.className = "secondary";
    btn.textContent = "Remove";
    btn.setAttribute("aria-label", `Remove ${host}`);
    btn.onclick = async () => {
      await savePrefs({ neverSites: neverSites.filter((h) => h !== host) });
      void renderNever();
    };
    li.append(host, btn);
    return li;
  }));
  neverEmpty.hidden = neverSites.length > 0;
}

$("save").onclick = async () => {
  const url = (server.value.trim() || DEFAULT_PREFS.serverUrl).replace(/\/+$/, "");
  server.value = url;
  await savePrefs({ serverUrl: url, apiKey: apiKey.value.trim() });
  setStatus("Saved.");
};

$("test").onclick = async () => {
  const url = (server.value.trim() || DEFAULT_PREFS.serverUrl).replace(/\/+$/, "");
  const key = apiKey.value.trim();
  try {
    const res = await fetch(`${url}/voices`, { headers: key ? { Authorization: `Bearer ${key}` } : {} });
    if (res.status === 401) return setStatus("Server reached, but the API key is missing or wrong.", false);
    if (!res.ok) return setStatus(`Server responded with HTTP ${res.status}.`, false);
    const health = await fetch(`${url}/health`).then((r) => r.json()).catch(() => ({}));
    setStatus(`Connected${health.gpu ? " (GPU)" : ""}.`);
  } catch {
    setStatus(`Can't reach ${url}. Is the server running?`, false);
  }
};

void loadPrefs(["serverUrl", "apiKey"]).then((p) => {
  server.value = p.serverUrl;
  apiKey.value = p.apiKey;
});
void renderNever();

void browser.extension.isAllowedFileSchemeAccess().then((allowed) => {
  $("file-access-status").textContent = allowed
    ? "File access is on: Voix can read files from your computer."
    : "File access is currently off.";
});
