import { Button, EmptyState } from "@selis/ui";
import { useTranslation } from "react-i18next";
import { TransferIllustration } from "../components/Illustrations";
import { ScreenHeader } from "../components/ScreenHeader";
import { useNavigation } from "../state/navigation";

/** P3 feature. Nothing on this screen opens a network connection yet. */
export function TransferScreen() {
  const { t } = useTranslation();
  const selectTab = useNavigation((s) => s.selectTab);
  return (
    <section className="flex flex-col">
      <ScreenHeader title={t("transfer.title")} />
      <EmptyState
        illustration={<TransferIllustration />}
        title={t("transfer.emptyTitle")}
        body={t("transfer.emptyBody")}
        action={
          <Button variant="secondary" onClick={() => selectTab("library")}>
            {t("transfer.goToLibrary")}
          </Button>
        }
      />
    </section>
  );
}
