// View state that is not part of the reader: which surface is showing.

export type Mode = "expanded" | "pill" | "closed";

export type Card =
  | { kind: "prompt"; minutes: number; noun?: "article" | "document" }
  | { kind: "privacy" }
  | { kind: "noArticle" }
  | { kind: "blocked" };

export interface UiState {
  mode: Mode;
  /** A card (prompt, privacy, no article...) replaces the panel while shown. */
  card: Card | null;
  /** The user has selected text on the page at some point (enables "Read selected text"). */
  hasSelection: boolean;
}

export class UiStore {
  private state: UiState = { mode: "closed", card: null, hasSelection: false };
  private listeners = new Set<() => void>();

  getState = (): UiState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(patch: Partial<UiState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }
}

/** Callbacks for decisions the host (content script or dev page) owns. */
export interface WidgetActions {
  onListen(): void;
  onNotNow(): void;
  onNeverOnSite(): void;
  onPrivacyAccepted(): void;
  onPrivacyDetails(): void;
  onReadSelection(): void;
  onReadWholePage(): void;
  /** Close the widget entirely (playback stops). */
  onClose(): void;
}
