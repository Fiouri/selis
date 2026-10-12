import { Button, Segmented, Switch } from "@selis/ui";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScreenHeader } from "../components/ScreenHeader";
import { Busy, LockFooter, Problem } from "../features/transfer/parts";
import { ReceivePanel } from "../features/transfer/ReceivePanel";
import { SendPanel } from "../features/transfer/SendPanel";
import { type TransferTab, transferStore, useTransfer } from "../features/transfer/transferStore";
import { api } from "../lib/api";

/**
 * Transfer (P3, brief §5). The only screen that uses the network: the
 * endpoint opens when it mounts and closes when it unmounts or the app goes to
 * the background (Rust keeps it while a transfer runs).
 */
export function TransferScreen() {
  const { t } = useTranslation();
  const tab = useTransfer((s) => s.tab);
  const setTab = useTransfer((s) => s.setTab);
  const info = useTransfer((s) => s.info);
  const opening = useTransfer((s) => s.opening);
  const openFailed = useTransfer((s) => s.openFailed);

  useEffect(() => {
    const store = transferStore().getState();
    void store.open();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void transferStore().getState().open();
      else void transferStore().getState().close();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      void transferStore().getState().close();
    };
  }, []);

  const options = [
    { value: "send", label: t("transfer.tabSend") },
    { value: "receive", label: t("transfer.tabReceive") },
  ] as const;

  return (
    <section className="flex flex-col" data-testid="transfer-screen">
      <ScreenHeader title={t("transfer.title")} />
      <div className="flex flex-col gap-4 px-5 pt-1">
        <Segmented<TransferTab>
          options={options}
          value={tab}
          onChange={setTab}
          label={t("transfer.tabsLabel")}
          idPrefix="transfer"
          testId="transfer-tabs"
        />
        <div role="tabpanel" id={`transfer-panel-${tab}`} aria-labelledby={`transfer-tab-${tab}`}>
          {openFailed ? (
            <div className="flex flex-col items-center gap-3 py-6">
              <Problem problem="openFailed" testId="transfer-open-failed" />
              <Button variant="secondary" onClick={() => void transferStore().getState().open()} data-testid="transfer-open-retry">
                {t("transfer.retry")}
              </Button>
            </div>
          ) : !info && opening ? (
            <Busy label={t("transfer.opening")} testId="transfer-opening" />
          ) : tab === "send" ? (
            <SendPanel />
          ) : (
            <ReceivePanel />
          )}
        </div>
        {info?.debug ? <ForceRelay /> : null}
      </div>
      <LockFooter />
    </section>
  );
}

/** Debug builds: route everything through the relay (testing the relay path). */
function ForceRelay() {
  const { t } = useTranslation();
  const [on, setOn] = useState(false);
  const label = useId();
  return (
    <div className="flex items-center gap-3 rounded-[14px] border border-dashed border-neutral-6 py-2 pr-2 pl-4">
      <div className="flex min-w-0 flex-1 flex-col">
        <span id={label} className="text-[13px] text-neutral-12">
          {t("transfer.debug.forceRelay")}
        </span>
        <span className="text-[12px] text-neutral-11">{t("transfer.debug.forceRelayHelp")}</span>
      </div>
      <Switch
        checked={on}
        onChange={(next) => {
          setOn(next);
          void api.transferDebugForceRelay(next).catch(() => setOn(!next));
        }}
        labelledBy={label}
        testId="transfer-force-relay"
      />
    </div>
  );
}
