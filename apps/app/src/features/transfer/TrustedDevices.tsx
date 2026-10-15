import { Button, cx } from "@selis/ui";
import { MonitorSmartphone, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Sheet } from "../../components/Sheet";
import { useToast } from "../../components/Toast";
import type { PingView, TrustedDevice } from "../../lib/api";
import { useTransfer } from "./transferStore";

/** Saved devices are pinged this often while the Send tab is on screen. */
const PING_EVERY_MS = 10_000;

function status(ping: PingView | null | undefined): "checking" | "ready" | "online" | "offline" {
  if (ping === undefined || ping === null) return "checking";
  if (ping.ready) return "ready";
  return ping.online ? "online" : "offline";
}

/**
 * Trusted devices (brief §5): rows 60 px, 36 px icon tile, name 15 / 600,
 * status 12, a "Send" pill that is disabled unless the device is ready.
 */
export function TrustedDevices({
  canSend,
  onSend,
  testId,
}: {
  canSend: boolean;
  onSend: (device: TrustedDevice) => void;
  testId: string;
}) {
  const { t } = useTranslation();
  const trusted = useTransfer((s) => s.trusted);
  const pings = useTransfer((s) => s.pings);
  const pingTrusted = useTransfer((s) => s.pingTrusted);
  const removeDevice = useTransfer((s) => s.removeDevice);
  const [removing, setRemoving] = useState<TrustedDevice | null>(null);
  const count = trusted.length;

  useEffect(() => {
    if (count === 0) return;
    void pingTrusted();
    const timer = window.setInterval(() => void pingTrusted(), PING_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [count, pingTrusted]);

  if (count === 0) return null;
  return (
    <section className="flex flex-col gap-2" data-testid={testId}>
      <div className="flex flex-col">
        <h2 className="text-[15px] font-semibold text-neutral-12">{t("transfer.trust.sectionTitle")}</h2>
        <p className="text-[13px] text-neutral-11">{t("transfer.trust.sectionHelp")}</p>
      </div>
      <ul className="flex flex-col overflow-hidden rounded-[14px] border border-neutral-5 bg-surface-raised">
        {trusted.map((device, i) => {
          const state = status(pings[device.endpointId]);
          return (
            <li
              key={device.endpointId}
              className={cx("flex min-h-15 items-center gap-3 py-2 pr-2 pl-3", i > 0 && "border-t border-neutral-5")}
              data-testid="trusted-device"
              data-status={state}
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-accent-3 text-accent-11" aria-hidden="true">
                <MonitorSmartphone size={20} strokeWidth={1.75} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="line-clamp-2 text-[15px] leading-snug font-semibold break-words text-neutral-12">{device.name}</span>
                <span className={cx("text-[12px]", state === "ready" ? "text-success-11" : "text-neutral-11")}>
                  {t(`transfer.trust.${state}`)}
                </span>
              </span>
              <button
                type="button"
                className="selis-focus inline-flex h-11 shrink-0 items-center rounded-full px-1 disabled:opacity-50"
                disabled={!canSend || state !== "ready"}
                onClick={() => onSend(device)}
                aria-label={t("transfer.trust.sendTo", { name: device.name })}
                data-testid="trusted-send"
              >
                {/* 32 px pill inside a 44 px target. */}
                <span className="rounded-full bg-accent-9 px-3 py-1.5 text-[13px] font-semibold text-accent-contrast">
                  {t("transfer.trust.send")}
                </span>
              </button>
              <button
                type="button"
                className="selis-focus flex size-11 shrink-0 items-center justify-center rounded-full text-neutral-11 active:bg-neutral-3"
                aria-label={t("transfer.trust.removeLabel", { name: device.name })}
                onClick={() => setRemoving(device)}
                data-testid="trusted-remove"
              >
                <X size={18} strokeWidth={2} aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
      <ConfirmDialog
        open={removing !== null}
        title={t("transfer.trust.removeTitle", { name: removing?.name ?? "" })}
        message={t("transfer.trust.removeBody")}
        confirmLabel={t("transfer.trust.remove")}
        cancelLabel={t("transfer.cancel")}
        danger
        onConfirm={() => {
          if (removing) void removeDevice(removing.endpointId);
          setRemoving(null);
        }}
        onCancel={() => setRemoving(null)}
        testId="trusted-remove-dialog"
      />
    </section>
  );
}

/** "Save this device" after a transfer with a device that is not trusted yet. */
export function SaveDevice({ peer }: { peer: string }) {
  const { t } = useTranslation();
  const saveDevice = useTransfer((s) => s.saveDevice);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const inputId = useId();
  const save = async () => {
    const ok = await saveDevice(peer, name.trim() || t("transfer.trust.defaultName"));
    if (ok) {
      setOpen(false);
      useToast.getState().show(t("transfer.trust.saved"));
    } else {
      useToast.getState().show(t("errors.generic"), "error");
    }
  };
  return (
    <>
      <Button variant="secondary" className="w-full" onClick={() => setOpen(true)} data-testid="transfer-save-device">
        {t("transfer.trust.save")}
      </Button>
      <Sheet open={open} onClose={() => setOpen(false)} title={t("transfer.trust.saveTitle")} testId="save-device-sheet">
        <form
          className="flex flex-col gap-3 px-5 pb-5"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <p className="text-[13px] text-neutral-11">{t("transfer.trust.saveHelp")}</p>
          <label htmlFor={inputId} className="text-[13px] font-medium text-neutral-11">
            {t("transfer.trust.nameLabel")}
          </label>
          <input
            id={inputId}
            value={name}
            maxLength={60}
            placeholder={t("transfer.trust.defaultName")}
            onChange={(event) => setName(event.target.value)}
            className="selis-focus h-12 w-full rounded-control border border-control-line bg-surface-app px-3 text-md text-neutral-12"
            data-testid="save-device-name"
          />
          <Button type="submit" data-testid="save-device-confirm">
            {t("transfer.trust.saveConfirm")}
          </Button>
        </form>
      </Sheet>
    </>
  );
}
