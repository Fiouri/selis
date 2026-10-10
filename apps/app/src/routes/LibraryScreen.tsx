import { Button, EmptyState, IconButton } from "@selis/ui";
import { useQueryClient } from "@tanstack/react-query";
import { FilePlus2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { LibraryIllustration } from "../components/Illustrations";
import { ScreenHeader } from "../components/ScreenHeader";
import { useToast } from "../components/Toast";
import { DocumentList, DocumentListSkeleton, documentTitle } from "../features/library/DocumentList";
import type { ImportErrorState } from "../features/library/importController";
import { isBusy } from "../features/library/importMachine";
import { addImportedDocument, useDocuments } from "../features/library/queries";
import { importController, useImportState } from "../features/library/useImport";
import { errorMessageKey } from "../lib/api";
import { useNavigation } from "../state/navigation";

export function LibraryScreen({ activeId = null }: { activeId?: string | null }) {
  const { t } = useTranslation();
  const documents = useDocuments();
  const importState = useImportState();
  const queryClient = useQueryClient();
  const openDocument = useNavigation((s) => s.openDocument);
  const showToast = useToast((s) => s.show);

  const errorText = (state: ImportErrorState): string => {
    if (state.kind === "timeout") return t("errors.importTimeout");
    if (state.kind === "resultLost") return t("errors.pickerLost");
    return t(errorMessageKey(state.error));
  };

  const handlers = {
    onDone: (outcome: Parameters<typeof addImportedDocument>[1]) => {
      addImportedDocument(queryClient, outcome);
      if (outcome.duplicate) {
        showToast(t("library.duplicate", { title: documentTitle(outcome.document, t("library.untitled")) }));
      }
      openDocument(outcome.document.id);
    },
    onError: (state: ImportErrorState) => {
      showToast(errorText(state), "error", {
        action: { label: t("errors.retry"), onClick: () => importController().retry() },
        onDismiss: () => importController().dismiss(),
      });
    },
  };
  const onImport = () => importController().start(handlers);

  const busy = isBusy(importState);
  const importLabel = importState.status === "importing" ? t("library.importing") : t("library.import");
  const docs = documents.data ?? [];

  return (
    <section className="flex flex-col">
      <ScreenHeader
        title={t("library.title")}
        subtitle={documents.data ? t("library.count", { count: docs.length }) : undefined}
        action={
          docs.length > 0 ? (
            <IconButton
              label={importLabel}
              icon={<FilePlus2 size={22} strokeWidth={1.75} />}
              onClick={onImport}
              disabled={busy}
              className="bg-accent-3 text-accent-11 hover:bg-accent-4"
            />
          ) : null
        }
      />
      {documents.isPending ? (
        <DocumentListSkeleton />
      ) : documents.isError ? (
        <EmptyState
          illustration={<LibraryIllustration />}
          title={t("errors.generic")}
          body={t(errorMessageKey(documents.error))}
          action={
            <Button variant="secondary" onClick={() => void documents.refetch()}>
              {t("errors.retry")}
            </Button>
          }
        />
      ) : docs.length === 0 ? (
        <EmptyState
          illustration={<LibraryIllustration />}
          title={t("library.emptyTitle")}
          body={t("library.emptyBody")}
          action={
            <Button
              icon={<FilePlus2 size={20} strokeWidth={1.75} />}
              onClick={onImport}
              disabled={busy}
            >
              {importLabel}
            </Button>
          }
        />
      ) : (
        <DocumentList documents={docs} activeId={activeId} onOpen={openDocument} />
      )}
    </section>
  );
}
