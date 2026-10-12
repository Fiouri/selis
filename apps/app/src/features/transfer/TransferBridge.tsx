import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../../lib/api";
import { useNavigation } from "../../state/navigation";
import { refreshLibrary } from "../library/queries";
import { onDocumentsReceived, transferStore } from "./transferStore";

/** Lets a warm deep link land (onNewIntent) before asking Rust for it. */
const RESUME_DELAY_MS = 250;

/**
 * App-wide side of Transfer:
 * - `selis://transfer/…` links (a QR code scanned with the camera app) open the
 *   Receive tab and start receiving once the endpoint is open;
 * - Android's foreground-service timeout pauses running receives;
 * - received documents refresh the library listings.
 */
export function TransferBridge() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let disposed = false;
    const check = async () => {
      let link: string | null;
      try {
        link = await api.pendingTransferLink();
      } catch {
        return;
      }
      if (!link || disposed) return;
      await api.dismissTransferLink(link).catch(() => undefined);
      useNavigation.getState().selectTab("transfer");
      transferStore().getState().setIncomingLink(link);
    };
    void check();

    let timer = 0;
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void check(), RESUME_DELAY_MS);
    };
    const onTimeout = () => void transferStore().getState().pauseAll();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("selis:transfer-timeout", onTimeout);
    const unsubscribe = onDocumentsReceived(() => refreshLibrary(queryClient));
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("selis:transfer-timeout", onTimeout);
      unsubscribe();
    };
  }, [queryClient]);

  return null;
}
