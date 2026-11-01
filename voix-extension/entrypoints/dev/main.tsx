// Dev page: the real widget in a Shadow DOM, driven by MockReaderController,
// with buttons to trigger every state in the design brief.
import ReactDOM from "react-dom/client";
import { MockReaderController } from "../../src/controller/mock";
import { loadVoixFont } from "../../src/ui/font";
import { UiStore, type WidgetActions } from "../../src/ui/uiStore";
import { Widget } from "../../src/ui/Widget";
import css from "../../src/ui/widget.css?inline";

const controller = new MockReaderController();
const ui = new UiStore();

const actions: WidgetActions = {
  onListen: () => { ui.set({ card: null, mode: "expanded" }); controller.restart(); },
  onNotNow: () => ui.set({ card: null }),
  onNeverOnSite: () => ui.set({ card: null }),
  onPrivacyAccepted: () => { ui.set({ card: null, mode: "expanded" }); controller.restart(); },
  onPrivacyDetails: () => alert("Opens the privacy section of the options page."),
  onReadSelection: () => { ui.set({ card: null, mode: "expanded" }); controller.restart(); },
  onReadWholePage: () => { ui.set({ card: null, mode: "expanded" }); controller.restart(); },
  onClose: () => { controller.stop(); ui.set({ mode: "closed", card: null }); },
};

const host = document.getElementById("widget-host")!;
const shadow = host.attachShadow({ mode: "open" });
const style = document.createElement("style");
style.textContent = css;
const container = document.createElement("div");
shadow.append(style, container);
ReactDOM.createRoot(container).render(<Widget controller={controller} ui={ui} actions={actions} />);
void loadVoixFont("/fonts/PlusJakartaSans-Variable.woff2");

const STATES: [string, () => void][] = [
  ["Expanded · playing", () => { ui.set({ card: null, mode: "expanded" }); controller.restart(); }],
  ["Expanded · paused at 5/12", () => { ui.set({ card: null, mode: "expanded" }); controller.jumpTo(4); controller.pause(); }],
  ["1 · Prompt card", () => ui.set({ card: { kind: "prompt", minutes: 6 } })],
  ["2 · Preparing voice", () => { ui.set({ card: null, mode: "expanded" }); controller.restart(); }],
  ["3 · Device-voice fallback", () => { ui.set({ card: null, mode: "expanded" }); controller.simulateFallback(); }],
  ["4 · No article found", () => ui.set({ card: { kind: "noArticle" }, hasSelection: false })],
  ["4b · No article (with selection)", () => ui.set({ card: { kind: "noArticle" }, hasSelection: true })],
  ["5 · Minimised pill", () => { ui.set({ card: null, mode: "pill" }); if (controller.getState().status === "idle") controller.play(); }],
  ["6 · Privacy notice", () => ui.set({ card: { kind: "privacy" } })],
  ["Blocked site (banking/email)", () => ui.set({ card: { kind: "blocked" } })],
  ["Error", () => { ui.set({ card: null, mode: "expanded" }); controller.simulateError(); }],
  ["Close", () => actions.onClose()],
];

const dev = document.getElementById("dev")!;
const title = document.createElement("h2");
title.textContent = "Voix dev states";
dev.append(title, ...STATES.map(([label, fn]) => {
  const b = document.createElement("button");
  b.textContent = label;
  b.onclick = fn;
  return b;
}));

// Deep link for screenshots: dev.html#state=3
const m = location.hash.match(/state=(\d+)/);
STATES[m ? Number(m[1]) : 0]?.[1]();
