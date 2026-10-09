import { EmptyState } from "@selis/ui";
import { useTranslation } from "react-i18next";
import { DesktopIllustration } from "../components/Illustrations";

/** Placeholder until P6 (full desktop shell). Narrow windows use the tablet/phone shells. */
export function DesktopShell() {
  const { t } = useTranslation();
  return (
    <main className="flex h-full items-center justify-center bg-surface-app" data-shell="desktop">
      <EmptyState
        illustration={<DesktopIllustration />}
        title={t("desktop.placeholderTitle")}
        body={t("desktop.placeholderBody")}
      />
    </main>
  );
}
