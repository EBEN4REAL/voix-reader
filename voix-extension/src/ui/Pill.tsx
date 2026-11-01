import type { ReaderController, ReaderState } from "../controller/types";
import type { DragHandlers } from "./hooks";
import { ChevronUpIcon, PauseIcon, PlayIcon, VoixLogo } from "./Icons";

const TITLES: Record<ReaderState["status"], string> = {
  idle: "Voix",
  preparing: "Voix · Preparing",
  playing: "Voix · Reading",
  paused: "Voix · Paused",
  error: "Voix · Stopped",
};

export function Pill({ state, controller, dragHandlers, onExpand }: {
  state: ReaderState;
  controller: ReaderController;
  dragHandlers: DragHandlers;
  onExpand(): void;
}) {
  const { status, currentIndex, sentences } = state;
  const total = sentences.length;
  const playing = status === "playing" || status === "preparing";
  return (
    <section className="voix-pill" aria-label="Voix reader (minimised)" tabIndex={-1} {...dragHandlers}>
      <VoixLogo size={32} />
      <button type="button" className="voix-pill-play" aria-label={playing ? "Pause" : "Play"}
        onClick={() => (playing ? controller.pause() : controller.play())} disabled={!total}>
        {playing ? <PauseIcon size={20} /> : <PlayIcon size={20} />}
      </button>
      <div className="voix-pill-text">
        <strong>{TITLES[status]}</strong>
        <span>{total ? `Sentence ${currentIndex + 1} of ${total}` : "Nothing loaded"}</span>
        <div className="voix-progress voix-progress-thin" aria-hidden="true">
          <span style={{ width: `${total ? (currentIndex / total) * 100 : 0}%` }} />
        </div>
      </div>
      <button type="button" className="voix-icon-btn" aria-label="Expand reader" onClick={onExpand}>
        <ChevronUpIcon />
      </button>
    </section>
  );
}
