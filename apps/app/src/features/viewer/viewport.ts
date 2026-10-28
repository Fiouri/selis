import { useSyncExternalStore } from "react";

/**
 * The scroller's visible area in content coordinates (CSS px), shared by the viewer
 * with its pages without re-rendering them on every scroll frame: tile layers read
 * it and subscribe (ADR 0002 amendment).
 */
export type ViewportState = {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  /** A pinch is in progress: the content is CSS-scaled, positions are stale. */
  readonly gesture: boolean;
};

export type ViewportBus = {
  get(): ViewportState;
  set(next: Partial<ViewportState>): void;
  subscribe(listener: () => void): () => void;
};

export function createViewportBus(): ViewportBus {
  let state: ViewportState = { left: 0, top: 0, width: 0, height: 0, gesture: false };
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: (next) => {
      const merged = { ...state, ...next };
      if (
        merged.left === state.left &&
        merged.top === state.top &&
        merged.width === state.width &&
        merged.height === state.height &&
        merged.gesture === state.gesture
      ) {
        return;
      }
      state = merged;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function subscribeRatio(notify: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => undefined;
  let query: MediaQueryList | null = null;
  const onChange = () => {
    notify();
    listen();
  };
  const listen = () => {
    query?.removeEventListener("change", onChange);
    query = window.matchMedia(`(resolution: ${String(window.devicePixelRatio || 1)}dppx)`);
    query.addEventListener("change", onChange);
  };
  listen();
  return () => query?.removeEventListener("change", onChange);
}

/** window.devicePixelRatio, updated when it changes (browser zoom, another display). */
export function useDevicePixelRatio(): number {
  return useSyncExternalStore(subscribeRatio, () => window.devicePixelRatio || 1);
}
