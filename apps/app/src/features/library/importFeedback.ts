/** What the user sees after an import, shared by the picker and "Open with". */
import type { QueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useToast } from "../../components/Toast";
import { errorMessageKey, type ImportOutcome } from "../../lib/api";
import { useNavigation } from "../../state/navigation";
import type { ImportErrorState } from "./importController";
import { addImportedDocument } from "./queries";
import { importController } from "./useImport";

export function documentTitle(doc: { title: string }, untitled: string): string {
  return doc.title.trim() || untitled;
}

export function importErrorText(t: TFunction, state: ImportErrorState): string {
  if (state.kind === "timeout") return t("errors.importTimeout");
  if (state.kind === "resultLost") return t("errors.pickerLost");
  return t(errorMessageKey(state.error));
}

/** Adds the document to the library and, unless told otherwise, opens it. */
export function showImported(
  queryClient: QueryClient,
  t: TFunction,
  outcome: ImportOutcome,
  options: { open: boolean } = { open: true },
): void {
  addImportedDocument(queryClient, outcome);
  if (outcome.duplicate) {
    useToast.getState().show(t("library.duplicate", { title: documentTitle(outcome.document, t("library.untitled")) }));
  }
  if (options.open) useNavigation.getState().openDocument(outcome.document.id);
}

/** Error toast with "Try again" (re-imports the same file, or reopens the picker). */
export function showImportError(t: TFunction, state: ImportErrorState): void {
  useToast.getState().show(importErrorText(t, state), "error", {
    action: { label: t("errors.retry"), onClick: () => importController().retry() },
    onDismiss: () => importController().dismiss(),
  });
}
