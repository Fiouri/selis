import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "../../components/Toast";
import { api } from "../../lib/api";
import { showImported, showImportError } from "./importFeedback";
import { OpenWithInbox } from "./openWithInbox";
import { importController } from "./useImport";

/** Lets a warm "Open with" land (onNewIntent) before asking Rust for it. */
const RESUME_DELAY_MS = 250;

/**
 * Imports documents handed over by other apps (commands/open_with.rs): on
 * startup and whenever the app comes back to the foreground. One document opens
 * the viewer; several stay in the library with a summary.
 */
export function OpenWithBridge() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  useEffect(() => {
    const controller = importController();
    const inbox = new OpenWithInbox({
      pending: api.pendingOpens,
      dismiss: api.dismissOpen,
      importSource: (source, name, handlers) => controller.importSource(source, name, handlers),
      subscribe: controller.subscribe,
      onImported: (outcome, batch) => {
        const single = batch.last && batch.count === 1;
        showImported(queryClient, t, outcome, { open: single });
        if (batch.last && batch.count > 1) useToast.getState().show(t("library.importedMany", { count: batch.count }));
      },
      onFailed: (state) => {
        showImportError(t, state);
      },
      log: (message, error) => {
        console.warn(message, error);
      },
    });
    void inbox.check();

    let timer = 0;
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void inbox.check(), RESUME_DELAY_MS);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearTimeout(timer);
      inbox.dispose();
    };
  }, [queryClient, t]);

  return null;
}
