import { Button } from "@selis/ui";
import { Truck } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Sheet } from "../../components/Sheet";
import { formatBytes } from "./format";
import { useTransfer } from "./transferStore";

/**
 * Library move (ADR 0014): a dry run first — what goes, how much — then a QR
 * code for the new phone, or a saved device that is ready.
 */
export function MoveLibrary() {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const summary = useTransfer((s) => s.moveSummary);
  const loadMoveSummary = useTransfer((s) => s.loadMoveSummary);
  const moveOffer = useTransfer((s) => s.moveOffer);
  const movePush = useTransfer((s) => s.movePush);
  const preparing = useTransfer((s) => s.preparing);
  const trusted = useTransfer((s) => s.trusted);
  const pings = useTransfer((s) => s.pings);
  const ready = trusted.filter((d) => pings[d.endpointId]?.ready === true);
  const empty = summary !== null && summary.documents === 0;

  return (
    <>
      <Button
        variant="ghost"
        icon={<Truck size={20} strokeWidth={1.75} aria-hidden="true" />}
        onClick={() => {
          setOpen(true);
          void loadMoveSummary();
        }}
        data-testid="transfer-move-open"
      >
        {t("transfer.move.open")}
      </Button>
      <Sheet open={open} onClose={() => setOpen(false)} title={t("transfer.move.title")} testId="transfer-move-sheet">
        <div className="flex flex-col gap-3 px-5 pb-5">
          <p className="text-[13px] text-neutral-11">{t("transfer.move.body")}</p>
          {summary ? (
            <ul className="flex flex-col gap-1 rounded-[14px] border border-neutral-5 bg-surface-raised p-4 text-md text-neutral-12 tabular-nums" data-testid="transfer-move-summary">
              <li>{t("transfer.move.documents", { count: summary.documents })}</li>
              <li>{t("transfer.move.versions", { count: summary.versions })}</li>
              <li>{t("transfer.move.tags", { count: summary.tags })}</li>
              <li>{t("transfer.move.signatures", { count: summary.signatures })}</li>
              <li className="pt-1 font-semibold">{t("transfer.move.size", { size: formatBytes(summary.bytes, i18n.language) })}</li>
            </ul>
          ) : null}
          <p className="text-[13px] text-neutral-11">{t("transfer.move.repeatNote")}</p>
          {empty ? (
            <p className="text-md text-neutral-11" data-testid="transfer-move-empty">
              {t("transfer.move.empty")}
            </p>
          ) : (
            <>
              <Button
                disabled={preparing || summary === null}
                onClick={() => {
                  setOpen(false);
                  void moveOffer();
                }}
                data-testid="transfer-move-qr"
              >
                {t("transfer.move.qr")}
              </Button>
              {ready.map((device) => (
                <Button
                  key={device.endpointId}
                  variant="secondary"
                  disabled={preparing || summary === null}
                  onClick={() => {
                    setOpen(false);
                    void movePush(device);
                  }}
                  data-testid="transfer-move-device"
                >
                  {t("transfer.move.toDevice", { name: device.name })}
                </Button>
              ))}
            </>
          )}
        </div>
      </Sheet>
    </>
  );
}
