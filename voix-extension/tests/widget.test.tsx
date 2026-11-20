import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockReaderController } from "../src/controller/mock";
import { UiStore, type WidgetActions } from "../src/ui/uiStore";
import { Widget } from "../src/ui/Widget";

function setup(mode: "expanded" | "pill" = "expanded") {
  const controller = new MockReaderController({ sentenceMs: 1000, preparingMs: 100 });
  const ui = new UiStore();
  ui.set({ mode });
  const actions: WidgetActions = {
    onListen: vi.fn(), onNotNow: vi.fn(), onNeverOnSite: vi.fn(), onPrivacyAccepted: vi.fn(),
    onPrivacyDetails: vi.fn(), onReadSelection: vi.fn(), onReadWholePage: vi.fn(),
    onClose: vi.fn(() => { controller.stop(); ui.set({ mode: "closed" }); }),
  };
  render(<Widget controller={controller} ui={ui} actions={actions} />);
  const user = userEvent.setup({ delay: null, advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
  return { controller, ui, actions, user };
}

const startPlaying = (controller: MockReaderController) => act(() => {
  controller.play();
  vi.advanceTimersByTime(100);
});

describe("Widget", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  describe("transport", () => {
    it("shows Play, then Preparing voice, Pause and Resume", async () => {
      const { controller, user } = setup();
      await user.click(screen.getByRole("button", { name: "Play" }));
      expect(screen.getByRole("button", { name: /Preparing voice/ })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(100));
      await user.click(screen.getByRole("button", { name: "Pause" }));
      expect(controller.getState().status).toBe("paused");
      expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
    });

    it("next, previous and stop drive the controller", async () => {
      const { controller, user } = setup();
      startPlaying(controller);
      const next = vi.spyOn(controller, "next");
      const previous = vi.spyOn(controller, "previous");
      const stop = vi.spyOn(controller, "stop");
      await user.click(screen.getByRole("button", { name: "Next sentence" }));
      await user.click(screen.getByRole("button", { name: "Next sentence" }));
      await user.click(screen.getByRole("button", { name: "Previous sentence" }));
      expect(next).toHaveBeenCalledTimes(2);
      expect(previous).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Sentence 2 of 12")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Stop" }));
      expect(stop).toHaveBeenCalled();
      expect(screen.getByText("Sentence 1 of 12")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    });
  });

  describe("voice", () => {
    it("groups voices into Women and Men with friendly labels", () => {
      setup();
      const select = screen.getByLabelText("Voice");
      const groups = within(select).getAllByRole("group");
      expect(groups.map((g) => g.getAttribute("label"))).toEqual(["Women", "Men"]);
      expect(within(select).getByRole("option", { name: "Heart · US" })).toBeInTheDocument();
      expect(within(select).getByRole("option", { name: "George · UK" })).toBeInTheDocument();
    });

    it("changing voice keeps the position", async () => {
      const { controller, user } = setup();
      startPlaying(controller);
      act(() => vi.advanceTimersByTime(3000));
      await user.selectOptions(screen.getByLabelText("Voice"), "Emma · UK");
      expect(controller.getState()).toMatchObject({ voiceId: "bf_emma", currentIndex: 3 });
    });
  });

  describe("speed", () => {
    it("plus and minus step by 0.1 and update the labels", async () => {
      const { controller, user } = setup();
      await user.click(screen.getByRole("button", { name: "Faster" }));
      expect(controller.getState().speed).toBe(1.1);
      expect(screen.getByText("1.1× speed")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Slower" }));
      await user.click(screen.getByRole("button", { name: "Slower" }));
      expect(controller.getState().speed).toBe(0.9);
    });

    it("slider covers 0.5x to 3x and disables buttons at the limits", async () => {
      const { controller } = setup();
      const slider = screen.getByLabelText("Speed") as HTMLInputElement;
      expect(slider).toHaveAttribute("min", "0.5");
      expect(slider).toHaveAttribute("max", "3");
      act(() => controller.setSpeed(3));
      expect(screen.getByRole("button", { name: "Faster" })).toBeDisabled();
      act(() => controller.setSpeed(0.5));
      expect(screen.getByRole("button", { name: "Slower" })).toBeDisabled();
    });
  });

  describe("sentence list", () => {
    it("marks the current sentence and jumps when a row is clicked", async () => {
      const { controller, user } = setup();
      startPlaying(controller);
      const rows = () => within(screen.getByRole("list", { name: "Text being read" })).getAllByRole("button");
      expect(rows()[0]).toHaveAttribute("aria-current", "true");
      await user.click(rows()[6]!);
      expect(controller.getState().currentIndex).toBe(6);
      expect(rows()[6]).toHaveAttribute("aria-current", "true");
      expect(rows()[2]).toHaveClass("is-read");
      expect(screen.getByText("7 / 12")).toBeInTheDocument();
    });

    it("shows skeleton lines while preparing", async () => {
      const { controller } = setup();
      act(() => controller.play());
      expect(screen.queryByRole("list", { name: "Text being read" })).not.toBeInTheDocument();
    });
  });

  describe("display modes and settings", () => {
    it("minimising keeps playback going; closing stops it", async () => {
      const { controller, user, actions } = setup();
      startPlaying(controller);
      await user.click(screen.getByRole("button", { name: "Minimise reader" }));
      expect(screen.getByText("Voix · Reading")).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1000));
      expect(controller.getState()).toMatchObject({ status: "playing", currentIndex: 1 });
      await user.click(screen.getByRole("button", { name: "Expand reader" }));
      await user.click(screen.getByRole("button", { name: "Close reader" }));
      expect(actions.onClose).toHaveBeenCalled();
      expect(controller.getState().status).toBe("idle");
    });

    it("switches toggle highlight on page and auto-scroll", async () => {
      const { controller, user } = setup();
      const highlight = screen.getByRole("switch", { name: "Highlight on page" });
      expect(highlight).toHaveAttribute("aria-checked", "true");
      await user.click(highlight);
      expect(highlight).toHaveAttribute("aria-checked", "false");
      await user.click(screen.getByRole("switch", { name: "Auto-scroll" }));
      expect(controller.getState().settings).toEqual({ highlightOnPage: false, autoScroll: false });
    });

    it("shows the fallback notice and can dismiss it or retry", async () => {
      const { controller, user } = setup();
      act(() => controller.simulateFallback());
      expect(screen.getByText("Device voice")).toBeInTheDocument();
      expect(screen.getByText("Using your device's basic voice")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Dismiss" }));
      expect(screen.queryByText("Using your device's basic voice")).not.toBeInTheDocument();
      act(() => controller.retryNaturalVoice());
      expect(screen.getByText("Natural voice")).toBeInTheDocument();
    });
  });

  describe("keyboard (inside the widget)", () => {
    it("Space toggles, arrows move, +/- change speed, Esc minimises", async () => {
      const { controller, user } = setup();
      startPlaying(controller);
      screen.getByRole("region", { name: "Voix reader" }).focus();
      await user.keyboard(" ");
      expect(controller.getState().status).toBe("paused");
      await user.keyboard("{ArrowRight}{ArrowRight}{ArrowLeft}");
      expect(controller.getState().currentIndex).toBe(1);
      screen.getByRole("region", { name: "Voix reader" }).focus();
      await user.keyboard("++-");
      expect(controller.getState().speed).toBe(1.1);
      await user.keyboard("{Escape}");
      expect(screen.getByText("Voix · Reading")).toBeInTheDocument();
    });
  });

  describe("cards", () => {
    it("prompt card auto-dismisses after 12 seconds when untouched", () => {
      const { ui, actions } = setup();
      act(() => ui.set({ card: { kind: "prompt", minutes: 6 } }));
      act(() => vi.advanceTimersByTime(11_000));
      expect(actions.onNotNow).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(1_000));
      expect(actions.onNotNow).toHaveBeenCalled();
    });

    it("prompt card: Listen, Never on this site, Esc; no auto-dismiss while hovered", async () => {
      const { ui, actions, user } = setup();
      act(() => ui.set({ card: { kind: "prompt", minutes: 6 } }));
      expect(screen.getByRole("dialog", { name: "Listen to this article?" })).toBeInTheDocument();
      expect(screen.getByText("About 6 min · Natural voice")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Listen" }));
      await user.click(screen.getByRole("button", { name: "Never on this site" }));
      expect(actions.onListen).toHaveBeenCalled();
      expect(actions.onNeverOnSite).toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(20_000));
      expect(actions.onNotNow).not.toHaveBeenCalled(); // focus/hover holds it open
      await user.keyboard("{Escape}");
      expect(actions.onNotNow).toHaveBeenCalled();
    });

    it("no-article card disables Read selected text until there is a selection", async () => {
      const { ui, actions, user } = setup();
      act(() => ui.set({ card: { kind: "noArticle" } }));
      expect(screen.getByRole("button", { name: "Read selected text" })).toBeDisabled();
      await user.click(screen.getByRole("button", { name: "Read the whole page" }));
      expect(actions.onReadWholePage).toHaveBeenCalled();
      act(() => ui.set({ hasSelection: true }));
      await user.click(screen.getByRole("button", { name: "Read selected text" }));
      expect(actions.onReadSelection).toHaveBeenCalled();
    });

    it("privacy notice", async () => {
      const { ui, actions, user } = setup();
      act(() => ui.set({ card: { kind: "privacy" } }));
      expect(screen.getByRole("dialog", { name: "Before you listen" })).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Got it" }));
      await user.click(screen.getByRole("button", { name: "Privacy details" }));
      expect(actions.onPrivacyAccepted).toHaveBeenCalled();
      expect(actions.onPrivacyDetails).toHaveBeenCalled();
    });
  });

  describe("language", () => {
    const detection = (lang: string, extra = {}) =>
      ({ lang, confidence: 95, source: "text" as const, mixed: false, needsConfirm: false, ...extra });

    it("shows the reading language beside the voice picker", () => {
      const { controller } = setup();
      act(() => controller.simulateDetection(detection("es")));
      expect(screen.getByRole("button", { name: "Reading language: Spanish. Change" })).toHaveTextContent("Spanish");
      const select = screen.getByLabelText("Voice");
      expect(within(select).getByRole("option", { name: "Dora · Beta" })).toBeInTheDocument();
      expect(within(select).getAllByRole("group").map((g) => g.getAttribute("label"))).toEqual(["Women", "Men"]);
      expect(screen.getByText("Beta", { selector: ".voix-beta" })).toBeInTheDocument();
    });

    it("English voices carry no Beta tag", () => {
      setup();
      expect(screen.getByRole("button", { name: "Reading language: English. Change" })).toBeInTheDocument();
      expect(screen.queryByText("Beta", { selector: ".voix-beta" })).not.toBeInTheDocument();
    });

    it("the chip opens a list of languages written in their own language, current one ticked", async () => {
      const { controller, user } = setup();
      act(() => controller.simulateDetection(detection("es")));
      await user.click(screen.getByRole("button", { name: /Reading language/ }));
      const picker = screen.getByRole("group", { name: "Reading language" });
      const options = within(picker).getAllByRole("button").filter((b) => b.classList.contains("voix-picker-option"));
      expect(options.map((o) => o.textContent)).toEqual(expect.arrayContaining(
        ["DeutschBeta", "English", "EspañolBeta", "FrançaisBeta", "ItalianoBeta", "NederlandsBeta", "PortuguêsBeta"]));
      expect(within(picker).getByRole("button", { name: /Español/ })).toHaveAttribute("aria-current", "true");
      expect(within(picker).getByRole("button", { name: /Español/ })).toHaveFocus();
      await user.click(within(picker).getByRole("button", { name: /Italiano/ }));
      expect(screen.queryByRole("group", { name: "Reading language" })).not.toBeInTheDocument();
      expect(controller.getState()).toMatchObject({ language: { code: "it", savedForSite: true }, voiceId: "if_sara" });
      expect(screen.getByRole("button", { name: "Reading language: Italian. Change" })).toHaveFocus();
    });

    it("Reset forgets the site's choice", async () => {
      const { controller, user } = setup();
      act(() => controller.simulateDetection(detection("es")));
      act(() => controller.setLanguage("fr"));
      await user.click(screen.getByRole("button", { name: /Reading language/ }));
      expect(screen.getByText("Remembered for this site.")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Reset" }));
      expect(controller.getState().language).toMatchObject({ code: "es", savedForSite: false });
    });

    it("asks before reading an uncertain language: chip has a question mark, Play opens the list", async () => {
      const { controller, user } = setup();
      act(() => controller.simulateDetection(detection("es", { confidence: 55, needsConfirm: true })));
      expect(screen.getByRole("button", { name: /Reading language: Spanish, not confirmed/ })).toHaveTextContent("Spanish?");
      await user.click(screen.getByRole("button", { name: "Play" }));
      expect(screen.getByText("Which language is this?")).toBeInTheDocument();
      expect(controller.getState().status).toBe("idle");
      await user.click(screen.getByRole("button", { name: /Español/ }));
      expect(controller.getState().status).toBe("preparing");
    });

    it("Escape closes the list before it minimises the widget", async () => {
      const { controller, user } = setup();
      await user.click(screen.getByRole("button", { name: /Reading language/ }));
      await user.keyboard("{Escape}");
      expect(controller.getState().languagePickerOpen).toBe(false);
      expect(screen.getByRole("region", { name: "Voix reader" })).toBeInTheDocument();
    });

    it("unsupported language: says so, disables Play, offers another language and the device voice", async () => {
      const { controller, user } = setup();
      act(() => controller.simulateDetection(detection("tr")));
      expect(screen.getByText("Voix cannot read Turkish yet")).toBeInTheDocument();
      expect(document.querySelector("[aria-live='polite']")).toHaveTextContent("Voix cannot read Turkish yet.");
      expect(screen.getByRole("button", { name: "Play" })).toBeDisabled();
      expect(screen.getByLabelText("Voice")).toBeDisabled();
      await user.click(screen.getByRole("button", { name: "Choose another language" }));
      expect(screen.getByRole("group", { name: "Reading language" })).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Use my device voice" }));
      expect(controller.getState()).toMatchObject({ usingFallbackVoice: true, status: "preparing" });
      expect(screen.getByText("Reading Turkish with your device's voice")).toBeInTheDocument();
      expect(screen.queryByText("Using your device's basic voice")).not.toBeInTheDocument();
    });

    it("only one gender available: one-line notice", () => {
      const { controller } = setup();
      act(() => controller.simulateDetection(detection("fr"), "male"));
      expect(screen.getByText("Only a female voice is available for French.", { selector: ".voix-voice-notice" }))
        .toBeInTheDocument();
      expect(document.querySelector("[aria-live='polite']")).toHaveTextContent("Only a female voice is available for French.");
      expect(within(screen.getByLabelText("Voice")).getAllByRole("group").map((g) => g.getAttribute("label"))).toEqual(["Women"]);
    });

    it("mixed-language text says so on the chip", () => {
      const { controller } = setup();
      act(() => controller.simulateDetection(detection("en", { mixed: true })));
      expect(screen.getByRole("button", { name: "Reading language: English, mixed language. Change" }))
        .toHaveTextContent("Mixed language");
    });

    it("minimising closes the language list, so the widget stays minimised", async () => {
      const { controller, user } = setup();
      await user.click(screen.getByRole("button", { name: /Reading language/ }));
      await user.click(screen.getByRole("button", { name: "Minimise reader" }));
      expect(controller.getState().languagePickerOpen).toBe(false);
      expect(screen.getByRole("region", { name: "Voix reader (minimised)" })).toBeInTheDocument();
    });

    it("Play in the minimised pill opens the expanded panel when it needs a language", async () => {
      const { controller, user } = setup("pill");
      act(() => controller.simulateDetection(detection("it", { needsConfirm: true })));
      await user.click(screen.getByRole("button", { name: "Play" }));
      expect(screen.getByText("Which language is this?")).toBeInTheDocument();
    });
  });

  it("announces status changes politely", () => {
    const { controller } = setup();
    act(() => controller.play());
    expect(document.querySelector("[aria-live='polite']")).toHaveTextContent("Preparing voice");
  });

  it("every icon-only button has an accessible name", () => {
    setup();
    for (const b of screen.getAllByRole("button")) {
      expect(b).toHaveAccessibleName();
    }
  });
});
