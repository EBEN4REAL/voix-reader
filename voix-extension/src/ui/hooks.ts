import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { ReaderController, ReaderState } from "../controller/types";
import { loadPrefs, savePrefs, type Prefs } from "../storage";
import type { UiState, UiStore } from "./uiStore";

export function useReaderState(controller: ReaderController): ReaderState {
  const subscribe = useCallback(
    (onChange: () => void) => controller.subscribe(() => onChange()),
    [controller],
  );
  return useSyncExternalStore(subscribe, () => controller.getState());
}

export function useUiState(store: UiStore): UiState {
  return useSyncExternalStore(store.subscribe, store.getState);
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

type Position = NonNullable<Prefs["position"]>;
const EDGE = 24;

/**
 * Drag-to-move for the floating widget. The position is stored as distance
 * from the bottom-right corner, so switching between panel and pill keeps the
 * widget anchored where the user put it. Saved per browser.
 */
export function useDragPosition(enabled: boolean, layoutKey: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Position | null>(null);
  const drag = useRef<{ x: number; y: number; start: Position; w: number; h: number } | null>(null);

  useEffect(() => {
    void loadPrefs(["position"]).then((p) => setPos(p.position));
  }, []);

  // If the widget ends up off screen (saved position, resize, mode change), reset to bottom-right.
  const keepOnScreen = useCallback(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const r = el.getBoundingClientRect();
    if (r.left < 0 || r.top < 0 || r.right > window.innerWidth || r.bottom > window.innerHeight) {
      setPos(null);
      void savePrefs({ position: null });
    }
  }, [enabled]);

  useLayoutEffect(keepOnScreen, [keepOnScreen, pos, layoutKey]);
  useEffect(() => {
    window.addEventListener("resize", keepOnScreen);
    return () => window.removeEventListener("resize", keepOnScreen);
  }, [keepOnScreen]);

  const onPointerDown = (e: ReactPointerEvent) => {
    if (!enabled || e.button !== 0 || !ref.current) return;
    if ((e.target as Element).closest("button, select, input, a")) return;
    const r = ref.current.getBoundingClientRect();
    drag.current = {
      x: e.clientX,
      y: e.clientY,
      start: { right: window.innerWidth - r.right, bottom: window.innerHeight - r.bottom },
      w: r.width,
      h: r.height,
    };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const clamp = (v: number, max: number) => Math.round(Math.min(Math.max(v, 0), Math.max(0, max)));
    setPos({
      right: clamp(d.start.right - (e.clientX - d.x), window.innerWidth - d.w),
      bottom: clamp(d.start.bottom - (e.clientY - d.y), window.innerHeight - d.h),
    });
  };

  const onPointerUp = (e: ReactPointerEvent) => {
    if (!drag.current) return;
    drag.current = null;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    setPos((p) => {
      void savePrefs({ position: p });
      return p;
    });
  };

  const style = enabled
    ? { right: pos?.right ?? EDGE, bottom: pos?.bottom ?? EDGE }
    : undefined;

  return { ref, style, dragHandlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp } };
}

export type DragHandlers = ReturnType<typeof useDragPosition>["dragHandlers"];
