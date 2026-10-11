import { Button, EmptyState } from "@selis/ui";
import { useTranslation } from "react-i18next";
import { RecentIllustration } from "../components/Illustrations";
import { ScreenHeader } from "../components/ScreenHeader";
import { DocumentCollection, DocumentCollectionSkeleton } from "../features/library/DocumentCollection";
import { RECENT_DOCUMENTS } from "../features/library/libraryStore";
import { useDocuments } from "../features/library/queries";
import type { Document } from "../lib/api";
import { useNavigation } from "../state/navigation";
import { useSettings } from "../state/settings";

const lastOpened = (doc: Document) => doc.lastOpenedAt ?? doc.createdAt;

/** The library grid, most recently opened first (no import button). */
export function RecentScreen() {
  const { t } = useTranslation();
  const documents = useDocuments(RECENT_DOCUMENTS);
  const view = useSettings((s) => s.libraryView);
  const selectTab = useNavigation((s) => s.selectTab);
  const recent = documents.data ?? [];

  return (
    <section className="flex flex-col" data-testid="recent-screen">
      <ScreenHeader title={t("recent.title")} />
      <div className="h-4" />
      {documents.isPending ? (
        <DocumentCollectionSkeleton view={view} count={2} />
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
        <DocumentCollection documents={recent} view={view} dateOf={lastOpened} />
      )}
    </section>
  );
}
