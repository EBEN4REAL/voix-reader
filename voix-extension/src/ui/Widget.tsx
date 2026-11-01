import { useEffect, useState, type KeyboardEvent } from "react";
import type { ReaderController } from "../controller/types";
import { BlockedCard, NoArticleCard, PrivacyCard, PromptCard } from "./Cards";
import { ExpandedPanel } from "./ExpandedPanel";
import { useDragPosition, useMediaQuery, useReaderState, useUiState } from "./hooks";
import { Pill } from "./Pill";
import type { UiStore, WidgetActions } from "./uiStore";

interface Props {
  controller: ReaderController;
  ui: UiStore;
  actions: WidgetActions;
}

export function Widget({ controller, ui, actions }: Props) {
  const state = useReaderState(controller);
  const view = useUiState(ui);
  const narrow = useMediaQuery("(max-width: 419px)");
  const layoutKey = `${view.mode}|${view.card?.kind ?? ""}`;
  const { ref, style, dragHandlers } = useDragPosition(!narrow, layoutKey);
  const [fallbackDismissed, setFallbackDismissed] = useState(false);

  // A new fallback episode shows the notice again.
  useEffect(() => {
    if (!state.usingFallbackVoice) setFallbackDismissed(false);
  }, [state.usingFallbackVoice]);

  const announcement =
    state.status === "preparing" ? state.loadingMessage ?? "Preparing voice"
    : state.status === "error" ? `Voix stopped. ${state.error ?? ""}`
    : state.usingFallbackVoice ? "Using your device's basic voice. Natural voices are unavailable right now."
    : "";

  const minimise = () => ui.set({ mode: "pill" });
  const expand = () => ui.set({ mode: "expanded" });

  // Keyboard shortcuts only apply while focus is inside the widget.
  const onKeyDown = (e: KeyboardEvent) => {
    if (view.card) return;
    const tag = (e.target as HTMLElement).tagName;
    const inField = tag === "SELECT" || tag === "INPUT";
    const busy = state.status === "playing" || state.status === "preparing";
    switch (e.key) {
      case " ":
        if (inField || tag === "BUTTON") return; // keep native button/field behaviour
        busy ? controller.pause() : controller.play();
        break;
      case "ArrowLeft":
        if (inField) return;
        controller.previous();
        break;
      case "ArrowRight":
        if (inField) return;
        controller.next();
        break;
      case "+":
      case "=":
        controller.setSpeed(state.speed + 0.1);
        break;
      case "-":
      case "_":
        controller.setSpeed(state.speed - 0.1);
        break;
      case "Escape":
        if (view.mode === "expanded") minimise();
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  let content = null;
  const card = view.card;
  if (card?.kind === "prompt") {
    content = <PromptCard minutes={card.minutes} noun={card.noun} dragHandlers={dragHandlers}
      onListen={actions.onListen} onNotNow={actions.onNotNow} onNever={actions.onNeverOnSite} />;
  } else if (card?.kind === "privacy") {
    content = <PrivacyCard dragHandlers={dragHandlers} onAccept={actions.onPrivacyAccepted}
      onDetails={actions.onPrivacyDetails} onClose={actions.onClose} />;
  } else if (card?.kind === "noArticle") {
    content = <NoArticleCard hasSelection={view.hasSelection} dragHandlers={dragHandlers}
      onReadSelection={actions.onReadSelection} onReadWholePage={actions.onReadWholePage} onClose={actions.onClose} />;
  } else if (card?.kind === "blocked") {
    content = <BlockedCard dragHandlers={dragHandlers} onClose={actions.onClose} />;
  } else if (view.mode === "expanded") {
    content = (
      <ExpandedPanel state={state} controller={controller} dragHandlers={dragHandlers}
        showFallbackNotice={state.usingFallbackVoice && !fallbackDismissed}
        onDismissFallback={() => setFallbackDismissed(true)}
        onMinimise={minimise} onClose={actions.onClose} />
    );
  } else if (view.mode === "pill") {
    content = <Pill state={state} controller={controller} dragHandlers={dragHandlers} onExpand={expand} />;
  }

  return (
    <div className="voix-root">
      {content && (
        <div ref={ref} className={`voix-float${narrow ? " is-narrow" : ""}`} style={style} onKeyDown={onKeyDown}>
          {content}
        </div>
      )}
      <div className="voix-sr-only" aria-live="polite">{announcement}</div>
    </div>
  );
}
