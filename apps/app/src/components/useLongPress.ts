import { type KeyboardEvent, type MouseEvent, type PointerEvent, useRef } from "react";

const LONG_PRESS_MS = 500;
/** Finger travel that turns a press into a scroll. */
const MOVE_TOLERANCE_PX = 10;

/**
 * Long press (touch, pen, mouse), right click and the context-menu key all call
 * `onLongPress`. The click that ends a long press is swallowed, so the element
 * can keep its normal tap action.
 */
export function useLongPress(onLongPress: () => void) {
  const timer = useRef<number | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  /** When the timer last fired: the "contextmenu" of that same press is a duplicate. */
  const firedAt = useRef(0);

  const cancel = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  };

  const fire = () => {
    cancel();
    fired.current = true;
    firedAt.current = Date.now();
    onLongPress();
  };

  return {
    onPointerDown: (event: PointerEvent) => {
      fired.current = false;
      if (event.button !== 0) return;
      origin.current = { x: event.clientX, y: event.clientY };
      timer.current = window.setTimeout(fire, LONG_PRESS_MS);
    },
    onPointerMove: (event: PointerEvent) => {
      const start = origin.current;
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > MOVE_TOLERANCE_PX) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    // Android WebView also reports a long press as "contextmenu"; desktop: right click.
    onContextMenu: (event: MouseEvent) => {
      event.preventDefault();
      if (Date.now() - firedAt.current > LONG_PRESS_MS) fire();
    },
    onClickCapture: (event: MouseEvent) => {
      if (!fired.current) return;
      fired.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault();
        onLongPress();
      }
    },
  };
}
