import { IconButton } from "@selis/ui";
import { X } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";

type ToastTone = "info" | "error";
type ToastState = {
  message: string | null;
  tone: ToastTone;
  seq: number;
  show: (message: string, tone?: ToastTone) => void;
  dismiss: () => void;
};

export const useToast = create<ToastState>()((set) => ({
  message: null,
  tone: "info",
  seq: 0,
  show: (message, tone = "info") => set((s) => ({ message, tone, seq: s.seq + 1 })),
  dismiss: () => set({ message: null }),
}));

const TOAST_MS = 4000;

/** Polite live region above the tab bar; one message at a time. */
export function Toast({ bottomOffset }: { bottomOffset: string }) {
  const { t } = useTranslation();
  const { message, tone, seq, dismiss } = useToast();

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(dismiss, TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [message, seq, dismiss]);

  return (
    <div
      aria-live={tone === "error" ? "assertive" : "polite"}
      className="pointer-events-none fixed inset-x-0 z-30 flex justify-center px-4"
      style={{ bottom: bottomOffset }}
    >
      {message ? (
        <div
          role={tone === "error" ? "alert" : "status"}
          className={`pointer-events-auto flex max-w-md items-center gap-2 rounded-card py-1 pr-1 pl-4 text-sm shadow-3 ${
            tone === "error" ? "bg-danger-3 text-danger-11" : "bg-neutral-12 text-neutral-1"
          }`}
        >
          <span className="flex-1 py-2">{message}</span>
          <IconButton
            label={t("errors.dismiss")}
            icon={<X size={18} strokeWidth={1.75} />}
            onClick={dismiss}
            className="text-current hover:bg-transparent active:bg-transparent"
          />
        </div>
      ) : null}
    </div>
  );
}
