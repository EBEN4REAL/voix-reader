// A reading session knows how to follow the current sentence on the page for
// one kind of source: DOM text, a sub-frame, a PDF, or text with no DOM
// (Google Docs export, OCR) where only the widget's list can follow along.

import { browser } from "wxt/browser";
import type { FrameRequest, ToBackground } from "../controller/engine";
import type { DocEvent, DocRequest } from "../docs/protocol";
import type { PageText } from "../page/extract";
import { clearHighlight, highlightRange, scrollToRange } from "../page/highlight";

export interface Follow {
  highlightOnPage: boolean;
  autoScroll: boolean;
}

export interface Session {
  sync(index: number, follow: Follow, indexChanged: boolean): void;
  clear(): void;
}

export const TEXT_ONLY: Session = { sync() {}, clear() {} };

export class DomSession implements Session {
  constructor(private page: PageText) {}
  sync(index: number, follow: Follow, indexChanged: boolean) {
    const range = this.page.rangeFor(index);
    if (follow.highlightOnPage) highlightRange(range);
    else clearHighlight();
    if (follow.autoScroll && indexChanged) scrollToRange(range);
  }
  clear() {
    clearHighlight();
  }
}

function sendFrames(frames: FrameRequest) {
  const msg: ToBackground = { target: "background", frames };
  return browser.runtime.sendMessage(msg).catch(() => null);
}

/** Text in an iframe: highlight and scroll happen inside that frame. */
export class FrameSession implements Session {
  constructor(private frameId: number) {}
  sync(index: number, follow: Follow, indexChanged: boolean) {
    void sendFrames({ op: "highlight", frameId: this.frameId, index, highlight: follow.highlightOnPage, scroll: follow.autoScroll && indexChanged });
  }
  clear() {
    void sendFrames({ op: "clear", frameId: this.frameId });
  }
}

/** Starts document jobs (PDF, OCR) in the offscreen document and routes their events. */
export class DocJobs {
  private handlers = new Map<string, (e: DocEvent) => void>();

  constructor() {
    browser.runtime.onMessage.addListener((msg: { type?: string; event?: DocEvent }) => {
      if (msg?.type === "voix:doc-event" && msg.event) this.handlers.get(msg.event.jobId)?.(msg.event);
    });
  }

  newId(): string {
    return crypto.randomUUID();
  }

  /** Resolves once the job is queued (for screen OCR: once the screenshot is taken). */
  async start(jobId: string, req: DistributiveOmit<DocRequest, "jobId">, onEvent: (e: DocEvent) => void) {
    this.handlers.set(jobId, (e) => {
      if (e.type === "done" || e.type === "error") this.handlers.delete(jobId);
      onEvent(e);
    });
    const msg: ToBackground = { target: "background", doc: { ...req, jobId } as DocRequest };
    const res = (await browser.runtime.sendMessage(msg).catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!res?.ok) {
      this.handlers.delete(jobId);
      throw new Error(res?.error ?? "Voix couldn't start reading this document.");
    }
  }

  cancel(jobId: string) {
    this.handlers.delete(jobId);
    const msg: ToBackground = { target: "background", doc: { kind: "cancel", jobId } };
    browser.runtime.sendMessage(msg).catch(() => {});
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
