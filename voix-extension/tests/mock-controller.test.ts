import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockReaderController } from "../src/controller/mock";

describe("MockReaderController", () => {
  let c: MockReaderController;
  beforeEach(() => {
    vi.useFakeTimers();
    c = new MockReaderController({ sentenceMs: 1000, preparingMs: 500 });
  });
  afterEach(() => {
    c.dispose();
    vi.useRealTimers();
  });

  it("prepares, then plays and advances on a timer", () => {
    c.play();
    expect(c.getState().status).toBe("preparing");
    vi.advanceTimersByTime(500);
    expect(c.getState().status).toBe("playing");
    vi.advanceTimersByTime(1000);
    expect(c.getState().currentIndex).toBe(1);
  });

  it("advances faster at higher speed", () => {
    c.setSpeed(2);
    c.play();
    vi.advanceTimersByTime(500 + 500);
    expect(c.getState().currentIndex).toBe(1);
  });

  it("pause and resume keep the position", () => {
    c.play();
    vi.advanceTimersByTime(500 + 2000);
    c.pause();
    expect(c.getState()).toMatchObject({ status: "paused", currentIndex: 2 });
    vi.advanceTimersByTime(5000);
    expect(c.getState().currentIndex).toBe(2);
    c.play();
    expect(c.getState().status).toBe("playing");
  });

  it("stop returns to the first sentence", () => {
    c.play();
    vi.advanceTimersByTime(3500);
    c.stop();
    expect(c.getState()).toMatchObject({ status: "idle", currentIndex: 0 });
  });

  it("jumpTo, next and previous clamp to the article", () => {
    c.play();
    vi.advanceTimersByTime(500);
    c.jumpTo(5);
    expect(c.getState().currentIndex).toBe(5);
    c.jumpTo(999);
    expect(c.getState().currentIndex).toBe(c.getState().sentences.length - 1);
    c.jumpTo(0);
    c.previous();
    expect(c.getState().currentIndex).toBe(0);
    c.next();
    expect(c.getState().currentIndex).toBe(1);
  });

  it("clamps speed to 0.5-3 in 0.1 steps", () => {
    c.setSpeed(0.1);
    expect(c.getState().speed).toBe(0.5);
    c.setSpeed(9);
    expect(c.getState().speed).toBe(3);
    c.setSpeed(1.149);
    expect(c.getState().speed).toBe(1.1);
  });

  it("changing voice keeps the current position", () => {
    c.play();
    vi.advanceTimersByTime(500 + 3000);
    c.setVoice("bm_george");
    expect(c.getState()).toMatchObject({ voiceId: "bm_george", currentIndex: 3, status: "playing" });
    c.setVoice("not-a-voice");
    expect(c.getState().voiceId).toBe("bm_george");
  });

  it("notifies subscribers and stops notifying after unsubscribe", () => {
    const listener = vi.fn();
    const off = c.subscribe(listener);
    expect(listener).toHaveBeenCalledTimes(1); // current state on subscribe
    c.setSetting("autoScroll", false);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ settings: { highlightOnPage: true, autoScroll: false } }));
    off();
    c.setSetting("autoScroll", true);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
