import { type ReactNode, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { cx } from "./cx";

export type BottomSheetProps = {
  open: boolean;
  /** Overlay tap, Escape. (System back is wired by the app, see useOverlay.) */
  onClose: () => void;
  title: string;
  /** Visually hidden title (the content already says what this is). */
  hideTitle?: boolean;
  children: ReactNode;
  testId?: string;
};

/**
 * Modal bottom sheet: radius 20 20 0 0, raised surface, grab handle 36×4.
 * Rendered outside the app root, which is made inert while the sheet is open,
 * so focus and screen readers stay inside the sheet.
 */
export function BottomSheet({ open, onClose, title, hideTitle = false, children, testId }: BottomSheetProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = document.getElementById("root");
    root?.setAttribute("inert", "");
    panelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // Another sheet may have opened meanwhile; only the last one restores the app.
      if (!document.querySelector("[data-selis-sheet]")) root?.removeAttribute("inert");
      previous?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-40 flex flex-col justify-end" data-selis-sheet="">
      <div className="selis-fade-in absolute inset-0 bg-surface-overlay" aria-hidden="true" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid={testId}
        className={cx(
          "selis-sheet-in relative flex max-h-[85%] flex-col rounded-t-sheet border-t border-neutral-5 bg-surface-raised shadow-3 outline-none",
        )}
        style={{ paddingBottom: "calc(var(--safe-bottom) + 12px)", paddingLeft: "var(--safe-left)", paddingRight: "var(--safe-right)" }}
      >
        <div className="flex justify-center pt-2 pb-1" aria-hidden="true">
          <span className="h-1 w-9 rounded-full bg-neutral-6" />
        </div>
        <h2 id={titleId} className={hideTitle ? "sr-only" : "px-5 pt-2 pb-3 text-md font-semibold text-neutral-12"}>
          {title}
        </h2>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
