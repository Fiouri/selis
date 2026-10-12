/**
 * Shown once after a redacted version is saved (ADR 0009): the new version no
 * longer has what was removed, but the earlier versions in the history (the
 * imported original among them) still do. "Delete earlier versions" keeps only
 * the new one; "Keep them" leaves the history as it is.
 */
import { useTranslation } from "react-i18next";
import { Sheet } from "../../components/Sheet";

type Props = {
  open: boolean;
  busy: boolean;
  onDelete: () => void;
  onKeep: () => void;
};

export function EarlierVersionsSheet({ open, busy, onDelete, onKeep }: Props) {
  const { t } = useTranslation();
  return (
    <Sheet open={open} onClose={onKeep} title={t("redact.earlierTitle")} testId="redact-earlier-sheet">
      <div className="flex flex-col gap-3 px-5 pb-4">
        <p className="text-sm text-neutral-11">{t("redact.earlierBody")}</p>
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          className="selis-focus h-11 w-full rounded-full bg-danger-3 text-sm font-semibold text-danger-11 active:opacity-80 disabled:opacity-45"
          data-testid="redact-earlier-delete"
        >
          {t("redact.earlierDelete")}
        </button>
        <button
          type="button"
          onClick={onKeep}
          disabled={busy}
          className="selis-focus h-11 w-full rounded-full text-sm font-medium text-neutral-11 active:bg-neutral-3 disabled:opacity-45"
          data-testid="redact-earlier-keep"
        >
          {t("redact.earlierKeep")}
        </button>
      </div>
    </Sheet>
  );
}
