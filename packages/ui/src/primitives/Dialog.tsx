import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button";

export type ConfirmDialogProps = {
  open: boolean;
  title: string;
  message: string;
  /** Extra points under the message (e.g. side effects), shown as a list. */
  details?: readonly string[];
  confirmLabel: string;
  cancelLabel: string;
  /** Destructive action: the confirm button uses the danger colors. */
  danger?: boolean;
  onConfirm: () => void;
  /** Cancel button; also overlay tap and Escape unless `onDismiss` is given. */
  onCancel: () => void;
  /**
   * Overlay tap, Escape (and system back, wired by the app) when that must not
   * mean the Cancel button, e.g. when Cancel throws something away.
   */
  onDismiss?: () => void;
  testId?: string;
};

/**
 * Centered confirm dialog (radius 14, raised surface). Focus starts on Cancel,
 * so a stray Enter never confirms a destructive action. Like BottomSheet it is
 * portalled outside #root, which is made inert while it is open.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  details,
  confirmLabel,
  cancelLabel,
  danger = false,
  onConfirm,
  onCancel,
  onDismiss,
  testId,
}: ConfirmDialogProps) {
  const titleId = useId();
  const messageId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Callers pass a fresh closure on every render; the open/close effect must
  // not re-run for that (it would move focus back to the panel each time).
  const onCancelRef = useRef(onDismiss ?? onCancel);
  useEffect(() => {
    onCancelRef.current = onDismiss ?? onCancel;
  });

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = document.getElementById("root");
    root?.setAttribute("inert", "");
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancelRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (!document.querySelector("[data-selis-sheet]")) root?.removeAttribute("inert");
      previous?.focus();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center px-6" data-selis-sheet="">
      <div className="selis-fade-in absolute inset-0 bg-surface-overlay" aria-hidden="true" onClick={onDismiss ?? onCancel} />
      <div
        // No aria-modal (see BottomSheet): `inert` on #root keeps assistive tech here.
        role="alertdialog"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        data-testid={testId}
        className="selis-fade-in relative w-full max-w-sm rounded-card border border-neutral-5 bg-surface-raised p-5 shadow-3"
      >
        <h2 id={titleId} className="text-md font-semibold text-neutral-12">
          {title}
        </h2>
        <div id={messageId}>
          <p className="mt-2 text-sm text-neutral-11">{message}</p>
          {details && details.length > 0 ? (
            <ul
              className="mt-3 flex max-h-48 list-disc flex-col gap-1 overflow-y-auto pl-5 text-sm text-neutral-12"
              data-testid={testId && `${testId}-details`}
            >
              {details.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button ref={cancelRef} variant="secondary" onClick={onCancel} data-testid={testId && `${testId}-cancel`}>
            {cancelLabel}
          </Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} data-testid={testId && `${testId}-confirm`}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
