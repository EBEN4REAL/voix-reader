import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioEngine, EngineEvent, PlayRequest } from "../src/controller/engine";
import { Emitter } from "../src/controller/engine";
import { VoixReaderController } from "../src/controller/reader";

vi.mock("wxt/browser", () => ({ browser: {} }));

class FakeEngine implements AudioEngine {
  events = new Emitter<EngineEvent>();
  plays: PlayRequest[] = [];
  calls: string[] = [];
  rate = 1;
  play(req: PlayRequest) { this.plays.push(req); this.calls.push("play"); }
  pause() { this.calls.push("pause"); }
  resume() { this.calls.push("resume"); }
  stop() { this.calls.push("stop"); }
  setRate(rate: number) { this.rate = rate; }
  onEvent(l: (e: EngineEvent) => void) { return this.events.on(l); }
  get last() { return this.plays[this.plays.length - 1]!; }
  fire(type: "playing" | "ended") { this.events.emit({ type, requestId: this.last.requestId }); }
  fail(message = "boom") { this.events.emit({ type: "error", requestId: this.last.requestId, message }); }
}

const SENTENCES = ["One.", "Two.", "Three."].map((text, i) => ({ id: `s${i}`, text }));

describe("VoixReaderController", () => {
  let natural: FakeEngine;
  let fallback: FakeEngine;
  let c: VoixReaderController;

  beforeEach(() => {
    natural = new FakeEngine();
    fallback = new FakeEngine();
    c = new VoixReaderController(natural, fallback);
    c.load(SENTENCES);
  });

  it("is preparing until the first audio starts, then playing", () => {
    c.play();
    expect(c.getState().status).toBe("preparing");
    expect(natural.last).toMatchObject({ text: "One.", voiceId: "af_heart", lang: "en-US", prefetch: ["Two.", "Three."] });
    natural.fire("playing");
    expect(c.getState().status).toBe("playing");
  });

  it("moves to the next sentence when one ends and stops after the last", () => {
    c.play();
    natural.fire("playing");
    natural.fire("ended");
    expect(c.getState().currentIndex).toBe(1);
    expect(c.getState().status).toBe("playing"); // later sentences don't show "preparing" again
    natural.fire("ended");
    natural.fire("ended");
    expect(c.getState()).toMatchObject({ status: "idle", currentIndex: 0 });
  });

  it("pauses and resumes without restarting the sentence", () => {
    c.play();
    natural.fire("playing");
    c.pause();
    expect(c.getState().status).toBe("paused");
    c.play();
    expect(natural.calls.slice(-2)).toEqual(["pause", "resume"]);
    expect(natural.plays).toHaveLength(1);
  });

  it("ignores events from superseded requests", () => {
    c.play();
    const first = natural.last.requestId;
    c.jumpTo(2);
    natural.events.emit({ type: "ended", requestId: first });
    expect(c.getState().currentIndex).toBe(2);
  });

  it("falls back to the device voice on error and keeps reading", () => {
    c.play();
    natural.fire("playing");
    natural.fire("ended");
    natural.fail("HTTP 503");
    const s = c.getState();
    expect(s.usingFallbackVoice).toBe(true);
    expect(s.currentIndex).toBe(1);
    expect(fallback.last).toMatchObject({ text: "Two." });
    fallback.fire("playing");
    fallback.fire("ended");
    expect(fallback.last).toMatchObject({ text: "Three." });
  });

  it("try natural voice switches back from the current sentence", () => {
    c.play();
    natural.fail();
    fallback.fire("playing");
    c.retryNaturalVoice();
    expect(c.getState().usingFallbackVoice).toBe(false);
    expect(natural.last).toMatchObject({ text: "One." });
    expect(fallback.calls).toContain("stop");
  });

  it("reports an error only when the fallback also fails", () => {
    c.play();
    natural.fail();
    fallback.fail("no voices");
    expect(c.getState()).toMatchObject({ status: "error", error: "no voices" });
  });

  it("applies speed immediately and voice from the next sentence", () => {
    c.play();
    natural.fire("playing");
    c.setSpeed(1.5);
    expect(natural.rate).toBe(1.5);
    c.setVoice("bm_george");
    expect(natural.plays).toHaveLength(1); // current sentence not restarted
    natural.fire("ended");
    expect(natural.last).toMatchObject({ voiceId: "bm_george", lang: "en-GB", rate: 1.5 });
  });

  it("pauses when another tab takes over and restarts the sentence on resume", () => {
    c.play();
    natural.fire("playing");
    natural.events.emit({ type: "interrupted" });
    expect(c.getState().status).toBe("paused");
    c.play();
    expect(natural.plays).toHaveLength(2);
    expect(natural.last.text).toBe("One.");
  });

  it("stop halts both engines and returns to the start", () => {
    c.play();
    natural.fire("playing");
    natural.fire("ended");
    c.stop();
    expect(c.getState()).toMatchObject({ status: "idle", currentIndex: 0 });
    expect(natural.calls).toContain("stop");
    expect(fallback.calls).toContain("stop");
  });
});

describe("VoixReaderController streaming (PDF pages, OCR)", () => {
  let natural: FakeEngine;
  let c: VoixReaderController;
  const more = (from: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `p${from + i}`, text: `Sentence ${from + i}.` }));

  beforeEach(() => {
    natural = new FakeEngine();
    c = new VoixReaderController(natural, new FakeEngine());
  });

  it("shows preparing with a message, then starts on the first sentences", () => {
    c.prepare("Opening PDF…");
    expect(c.getState()).toMatchObject({ status: "preparing", loadingMessage: "Opening PDF…", sentences: [] });
    c.setLoadingMessage("Recognising text on page 1 of 3…");
    c.append(more(0, 2));
    expect(natural.last.text).toBe("Sentence 0.");
    natural.fire("playing");
    expect(c.getState().status).toBe("playing");
  });

  it("waits at the end of the loaded text and continues when the next page arrives", () => {
    c.prepare("Opening PDF…");
    c.append(more(0, 1));
    natural.fire("playing");
    natural.fire("ended");
    expect(natural.plays).toHaveLength(1); // nothing to play yet
    c.append(more(1, 2));
    expect(natural.last.text).toBe("Sentence 1.");
    expect(c.getState().sentences).toHaveLength(3);
  });

  it("finishes after the last page", () => {
    c.prepare("Opening PDF…");
    c.append(more(0, 1));
    natural.fire("playing");
    natural.fire("ended");
    c.finishLoading();
    expect(c.getState().status).toBe("idle");
  });

  it("fails clearly when a document has no text", () => {
    c.prepare("Opening PDF…");
    c.finishLoading("This PDF has no readable text.");
    expect(c.getState()).toMatchObject({ status: "error", error: "This PDF has no readable text." });
  });

  it("doesn't autoplay if paused while loading", () => {
    c.prepare("Opening PDF…");
    c.pause();
    c.append(more(0, 2));
    expect(natural.plays).toHaveLength(0);
    c.play();
    expect(natural.plays).toHaveLength(1);
  });

  it("restarts the sentence when the player lost its state", () => {
    c.load(more(0, 3));
    c.play();
    natural.fire("playing");
    c.pause();
    c.play(); // resume
    natural.events.emit({ type: "lost" });
    expect(natural.plays).toHaveLength(2);
    expect(natural.last.text).toBe("Sentence 0.");
  });
});
