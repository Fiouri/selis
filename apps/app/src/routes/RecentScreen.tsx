import { Button, EmptyState } from "@selis/ui";
import { useTranslation } from "react-i18next";
import { RecentIllustration } from "../components/Illustrations";
import { ScreenHeader } from "../components/ScreenHeader";
import { DocumentList, DocumentListSkeleton } from "../features/library/DocumentList";
import { selectRecent, useDocuments } from "../features/library/queries";
import { useNavigation } from "../state/navigation";

export function RecentScreen({ activeId = null }: { activeId?: string | null }) {
  const { t } = useTranslation();
  const documents = useDocuments();
  const openDocument = useNavigation((s) => s.openDocument);
  const selectTab = useNavigation((s) => s.selectTab);
  const recent = selectRecent(documents.data ?? []);

  return (
    <section className="flex flex-col">
      <ScreenHeader title={t("recent.title")} />
      {documents.isPending ? (
        <DocumentListSkeleton rows={3} />
      ) : recent.length === 0 ? (
        <EmptyState
          illustration={<RecentIllustration />}
          title={t("recent.emptyTitle")}
          body={t("recent.emptyBody")}
          action={
            <Button variant="secondary" onClick={() => selectTab("library")}>
              {t("recent.goToLibrary")}
            </Button>
          }
        />
      ) : (
        <DocumentList documents={recent} activeId={activeId} onOpen={openDocument} />
      )}
    </section>
  );
}
