import { IconButton } from "@selis/ui";
import { X } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";

type ToastTone = "info" | "error";
type ToastAction = { label: string; onClick: () => void };
type ToastOptions = { action?: ToastAction; onDismiss?: () => void };

type ToastState = {
  message: string | null;
  tone: ToastTone;
  action: ToastAction | null;
  onDismiss: (() => void) | null;
  seq: number;
  show: (message: string, tone?: ToastTone, options?: ToastOptions) => void;
  /** Hides the toast; runs its `onDismiss` unless the action was taken. */
  dismiss: (viaAction?: boolean) => void;
};

export const useToast = create<ToastState>()((set, get) => ({
  message: null,
  tone: "info",
  action: null,
  onDismiss: null,
  seq: 0,
  show: (message, tone = "info", options = {}) => {
    // A replaced toast counts as dismissed.
    get().onDismiss?.();
    set((s) => ({
      message,
      tone,
      action: options.action ?? null,
      onDismiss: options.onDismiss ?? null,
      seq: s.seq + 1,
    }));
  },
  dismiss: (viaAction = false) => {
    const { onDismiss } = get();
    set({ message: null, action: null, onDismiss: null });
    if (!viaAction) onDismiss?.();
  },
}));

const TOAST_MS = 4000;
const ACTION_TOAST_MS = 10_000;

/** Live region above the tab bar; one message at a time. */
export function Toast({ bottomOffset }: { bottomOffset: string }) {
  const { t } = useTranslation();
  const { message, tone, action, seq, dismiss } = useToast();

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => dismiss(), action ? ACTION_TOAST_MS : TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [message, seq, action, dismiss]);

  return (
    <div
      aria-live={tone === "error" ? "assertive" : "polite"}
      className="pointer-events-none fixed inset-x-0 z-30 flex justify-center px-4"
      style={{ bottom: bottomOffset }}
    >
      {message ? (
        <div
          role={tone === "error" ? "alert" : "status"}
          data-testid="toast"
          className={`pointer-events-auto flex max-w-md items-center gap-2 rounded-card py-1 pr-1 pl-4 text-sm shadow-3 ${
            tone === "error" ? "bg-danger-3 text-danger-11" : "bg-neutral-12 text-neutral-1"
          }`}
        >
          <span className="flex-1 py-2">{message}</span>
          {action ? (
            <button
              type="button"
              onClick={() => {
                dismiss(true);
                action.onClick();
              }}
              className="selis-focus min-h-11 rounded-control px-3 font-semibold underline-offset-2 hover:underline"
            >
              {action.label}
            </button>
          ) : null}
          <IconButton
            label={t("errors.dismiss")}
            icon={<X size={18} strokeWidth={1.75} />}
            onClick={() => dismiss()}
            className="text-current hover:bg-transparent active:bg-transparent"
          />
        </div>
      ) : null}
    </div>
  );
}
