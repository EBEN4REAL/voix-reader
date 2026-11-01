import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { DragHandlers } from "./hooks";
import { CloseIcon, VoixLogo } from "./Icons";

const PROMPT_TIMEOUT_MS = 12_000;

function Card({ title, onClose, dragHandlers, children, className = "" }: {
  title: string;
  onClose?: () => void;
  dragHandlers: DragHandlers;
  children: ReactNode;
  className?: string;
}) {
  const titleId = useId();
  return (
    <section className={`voix-card ${className}`} role="dialog" aria-labelledby={titleId}>
      <header className="voix-card-header" {...dragHandlers}>
        <VoixLogo size={32} />
        <span className="voix-card-brand">Voix</span>
        <span className="voix-spacer" />
        {onClose && (
          <button type="button" className="voix-icon-btn" aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        )}
      </header>
      <h2 id={titleId} className="voix-card-title">{title}</h2>
      {children}
    </section>
  );
}

export function PromptCard({ minutes, noun = "article", dragHandlers, onListen, onNotNow, onNever }: {
  minutes: number;
  noun?: "article" | "document";
  dragHandlers: DragHandlers;
  onListen(): void;
  onNotNow(): void;
  onNever(): void;
}) {
  const [held, setHeld] = useState(false); // hovered or focused: don't auto-dismiss
  const dismiss = useRef(onNotNow);
  dismiss.current = onNotNow;

  useEffect(() => {
    if (held) return;
    const t = setTimeout(() => dismiss.current(), PROMPT_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [held]);

  useEffect(() => {
    // Esc closes the card even while focus is on the page.
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && dismiss.current();
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)} onBlur={() => setHeld(false)}
      onKeyDown={(e) => e.key === "Escape" && onNotNow()}>
      <Card title={`Listen to this ${noun}?`} onClose={onNotNow} dragHandlers={dragHandlers} className="voix-card-prompt voix-enter">
        <p className="voix-card-sub">About {minutes} min · Natural voice</p>
        <div className="voix-card-row">
          <button type="button" className="voix-btn voix-btn-primary voix-grow voix-btn-48" onClick={onListen}>Listen</button>
          <button type="button" className="voix-btn voix-btn-outline voix-grow voix-btn-48" onClick={onNotNow}>Not now</button>
        </div>
        <button type="button" className="voix-btn voix-btn-link voix-center" onClick={onNever}>Never on this site</button>
      </Card>
    </div>
  );
}

export function NoArticleCard({ hasSelection, dragHandlers, onReadSelection, onReadWholePage, onClose }: {
  hasSelection: boolean;
  dragHandlers: DragHandlers;
  onReadSelection(): void;
  onReadWholePage(): void;
  onClose(): void;
}) {
  return (
    <Card title="We couldn't find an article here" onClose={onClose} dragHandlers={dragHandlers}>
      <p className="voix-card-body">This page may not be an article. You can still have Voix read part or all of it.</p>
      <div className="voix-card-stack">
        <button type="button" className="voix-btn voix-btn-primary voix-btn-48" onClick={onReadSelection}
          disabled={!hasSelection} aria-describedby={hasSelection ? undefined : "voix-select-hint"}>
          Read selected text
        </button>
        {!hasSelection && <p id="voix-select-hint" className="voix-hint">Select some text on the page first.</p>}
        <button type="button" className="voix-btn voix-btn-outline voix-btn-48" onClick={onReadWholePage}>
          Read the whole page
        </button>
      </div>
    </Card>
  );
}

export function PrivacyCard({ dragHandlers, onAccept, onDetails, onClose }: {
  dragHandlers: DragHandlers;
  onAccept(): void;
  onDetails(): void;
  onClose(): void;
}) {
  return (
    <Card title="Before you listen" onClose={onClose} dragHandlers={dragHandlers}>
      <p className="voix-card-body">
        To turn articles into natural speech, Voix sends the article text to our voice service. We don't keep it,
        and pages such as banking and email are never sent.
      </p>
      <div className="voix-card-stack">
        <button type="button" className="voix-btn voix-btn-primary voix-btn-48" onClick={onAccept}>Got it</button>
        <button type="button" className="voix-btn voix-btn-link voix-center" onClick={onDetails}>Privacy details</button>
      </div>
    </Card>
  );
}

export function BlockedCard({ dragHandlers, onClose }: { dragHandlers: DragHandlers; onClose(): void }) {
  return (
    <Card title="Voix is off on this page" onClose={onClose} dragHandlers={dragHandlers}>
      <p className="voix-card-body">
        To protect your privacy, pages such as banking and email are never sent to the voice service.
      </p>
      <div className="voix-card-stack">
        <button type="button" className="voix-btn voix-btn-outline voix-btn-48" onClick={onClose}>OK</button>
      </div>
    </Card>
  );
}
