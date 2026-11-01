import { useEffect, useRef, type CSSProperties } from "react";
import { MAX_SPEED, MIN_SPEED, type ReaderController, type ReaderState, type SettingKey } from "../controller/types";
import type { DragHandlers } from "./hooks";
import {
  ChevronDownIcon, CloseIcon, InfoIcon, MinusIcon, PauseIcon, PlayIcon, PlusIcon,
  SkipBackIcon, SkipForwardIcon, StopIcon, VoixLogo,
} from "./Icons";

interface Props {
  state: ReaderState;
  controller: ReaderController;
  dragHandlers: DragHandlers;
  showFallbackNotice: boolean;
  onDismissFallback(): void;
  onMinimise(): void;
  onClose(): void;
}

export const formatSpeed = (s: number) => `${s.toFixed(1)}×`;

export function ExpandedPanel({ state, controller, dragHandlers, showFallbackNotice, onDismissFallback, onMinimise, onClose }: Props) {
  const { status, sentences, currentIndex, speed, usingFallbackVoice } = state;
  const total = sentences.length;
  const preparing = status === "preparing";

  return (
    <section className="voix-panel" aria-label="Voix reader" tabIndex={-1}>
      <header className="voix-header" {...dragHandlers}>
        <VoixLogo size={32} />
        <span className="voix-wordmark">Voix</span>
        <span className="voix-chip">{usingFallbackVoice ? "Device voice" : "Natural voice"}</span>
        <span className="voix-spacer" />
        <button type="button" className="voix-icon-btn" aria-label="Minimise reader" onClick={onMinimise}>
          <ChevronDownIcon />
        </button>
        <button type="button" className="voix-icon-btn" aria-label="Close reader" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>

      <div className="voix-body">
        {showFallbackNotice && (
          <div className="voix-notice" role="status">
            <div className="voix-notice-text">
              <InfoIcon />
              <div>
                <strong>Using your device's basic voice</strong>
                <p>Natural voices are unavailable right now. Reading will continue.</p>
              </div>
            </div>
            <div className="voix-notice-actions">
              <button type="button" className="voix-btn voix-btn-outline voix-grow" onClick={() => controller.retryNaturalVoice()}>
                Try natural voice
              </button>
              <button type="button" className="voix-btn voix-btn-link" onClick={onDismissFallback}>
                Dismiss
              </button>
            </div>
          </div>
        )}

        {status === "error" && (
          <div className="voix-notice voix-notice-error" role="alert">
            <div className="voix-notice-text">
              <InfoIcon />
              <div>
                <strong>Voix stopped</strong>
                <p>{state.error ?? "Something went wrong."}{total ? " Press Play to try again." : ""}</p>
              </div>
            </div>
          </div>
        )}

        <div>
          <div className="voix-meta">
            <span aria-live="off">
              {preparing && state.loadingMessage ? state.loadingMessage
                : total ? `Sentence ${currentIndex + 1} of ${total}` : state.loadingMessage ?? "No text loaded"}
            </span>
            <span>{formatSpeed(speed)} speed</span>
          </div>
          <div className="voix-progress" role="progressbar" aria-label="Reading progress"
            aria-valuemin={0} aria-valuemax={total} aria-valuenow={currentIndex}>
            <span style={{ width: `${total ? (currentIndex / total) * 100 : 0}%` }} />
          </div>
        </div>

        <div className="voix-transport">
          <button type="button" className="voix-btn voix-btn-outline voix-btn-square" aria-label="Previous sentence"
            onClick={() => controller.previous()} disabled={!total || preparing}>
            <SkipBackIcon />
          </button>
          <PrimaryButton status={status} disabled={!total} controller={controller} />
          <button type="button" className="voix-btn voix-btn-outline voix-btn-square"
            aria-label={preparing ? "Cancel" : "Stop"} onClick={() => controller.stop()} disabled={!total && !preparing}>
            <StopIcon />
          </button>
          <button type="button" className="voix-btn voix-btn-outline voix-btn-square" aria-label="Next sentence"
            onClick={() => controller.next()} disabled={!total || preparing}>
            <SkipForwardIcon />
          </button>
        </div>

        <VoiceSelect state={state} controller={controller} />

        <div>
          <div className="voix-label">
            <label htmlFor="voix-speed">Speed</label>
            <span className="voix-label-value">{formatSpeed(speed)}</span>
          </div>
          <div className="voix-speed-row">
            <button type="button" className="voix-btn voix-btn-outline voix-btn-44" aria-label="Slower"
              onClick={() => controller.setSpeed(speed - 0.1)} disabled={speed <= MIN_SPEED}>
              <MinusIcon />
            </button>
            <input
              id="voix-speed"
              className="voix-range"
              type="range"
              min={MIN_SPEED}
              max={MAX_SPEED}
              step={0.1}
              value={speed}
              aria-valuetext={formatSpeed(speed)}
              style={{ "--fill": `${((speed - MIN_SPEED) / (MAX_SPEED - MIN_SPEED)) * 100}%` } as CSSProperties}
              onChange={(e) => controller.setSpeed(Number(e.target.value))}
            />
            <button type="button" className="voix-btn voix-btn-outline voix-btn-44" aria-label="Faster"
              onClick={() => controller.setSpeed(speed + 0.1)} disabled={speed >= MAX_SPEED}>
              <PlusIcon />
            </button>
          </div>
        </div>

        <SentenceList state={state} controller={controller} />
      </div>

      <footer className="voix-footer">
        <Switch label="Highlight on page" setting="highlightOnPage" state={state} controller={controller} />
        <Switch label="Auto-scroll" setting="autoScroll" state={state} controller={controller} />
      </footer>
    </section>
  );
}

function PrimaryButton({ status, disabled, controller }: { status: ReaderState["status"]; disabled: boolean; controller: ReaderController }) {
  if (status === "preparing") {
    return (
      <button type="button" className="voix-btn voix-btn-primary voix-grow" disabled aria-busy="true">
        <span className="voix-spinner" aria-hidden="true" />
        Preparing voice
      </button>
    );
  }
  const playing = status === "playing";
  return (
    <button type="button" className="voix-btn voix-btn-primary voix-grow" disabled={disabled}
      onClick={() => (playing ? controller.pause() : controller.play())}>
      {playing ? <PauseIcon /> : <PlayIcon />}
      {playing ? "Pause" : status === "paused" ? "Resume" : "Play"}
    </button>
  );
}

function VoiceSelect({ state, controller }: { state: ReaderState; controller: ReaderController }) {
  const groups = [
    { label: "Women", voices: state.voices.filter((v) => v.gender === "woman") },
    { label: "Men", voices: state.voices.filter((v) => v.gender === "man") },
  ];
  return (
    <div>
      <div className="voix-label">
        <label htmlFor="voix-voice">Voice</label>
      </div>
      <select id="voix-voice" className="voix-select" value={state.voiceId}
        onChange={(e) => controller.setVoice(e.target.value)}>
        {groups.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.voices.map((v) => (
              <option key={v.id} value={v.id}>{`${v.label} · ${v.accent}`}</option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

function SentenceList({ state, controller }: { state: ReaderState; controller: ReaderController }) {
  const { sentences, currentIndex, status, settings } = state;
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (!settings.autoScroll || !list) return;
    const row = list.children[currentIndex] as HTMLElement | undefined;
    if (!row) return;
    // Scroll the list only (scrollIntoView could also move the page).
    // The list is position: relative, so offsetTop is measured from its top.
    const top = row.offsetTop;
    if (top < list.scrollTop || top + row.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = top - 6;
    }
  }, [currentIndex, settings.autoScroll, status]);

  return (
    <div>
      <div className="voix-label">
        <span id="voix-list-label">Text being read</span>
        <span className="voix-label-value voix-muted-value">
          {sentences.length ? `${currentIndex + 1} / ${sentences.length}` : ""}
        </span>
      </div>
      {status === "preparing" ? (
        <div className="voix-list voix-list-skeleton" aria-hidden="true">
          <span /><span /><span />
        </div>
      ) : (
        <ol className="voix-list" ref={listRef} aria-labelledby="voix-list-label">
          {sentences.map((s, i) => (
            <li key={s.id}>
              <button
                type="button"
                className={`voix-sentence${i < currentIndex ? " is-read" : ""}`}
                aria-current={i === currentIndex ? "true" : undefined}
                onClick={() => controller.jumpTo(i)}
              >
                <span className="voix-sentence-num">{i + 1}.</span>
                <span>{s.text}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Switch({ label, setting, state, controller }: { label: string; setting: SettingKey; state: ReaderState; controller: ReaderController }) {
  const on = state.settings[setting];
  return (
    <button type="button" role="switch" aria-checked={on} className="voix-switch"
      onClick={() => controller.setSetting(setting, !on)}>
      <span>{label}</span>
      <span className="voix-switch-track" aria-hidden="true"><span className="voix-switch-thumb" /></span>
    </button>
  );
}
