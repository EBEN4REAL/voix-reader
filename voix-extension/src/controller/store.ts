import type { ReaderState } from "./types";

/** Minimal observable state shared by the mock and real controllers. */
export class StateStore {
  private listeners = new Set<(s: ReaderState) => void>();

  constructor(protected state: ReaderState) {}

  getState(): ReaderState {
    return this.state;
  }

  subscribe(listener: (s: ReaderState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  protected update(patch: Partial<ReaderState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }
}
