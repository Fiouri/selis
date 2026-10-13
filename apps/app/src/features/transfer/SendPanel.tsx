import { Button, EmptyState, Switch } from "@selis/ui";
import { Check } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { TransferIllustration } from "../../components/Illustrations";
import { useToast } from "../../components/Toast";
import type { Document, OfferView, RouteView } from "../../lib/api";
import { useNavigation } from "../../state/navigation";
import { ALL_DOCUMENTS } from "../library/libraryStore";
import { useDocuments } from "../library/queries";
import { formatBytes, formatCountdown } from "./format";
import { MoveLibrary } from "./MoveLibrary";
import { ExportPack } from "./PackSheets";
import { Busy, Card, CodeBlock, Problem, Progress } from "./parts";
import { type Push, type TransferProblem, useTransfer } from "./transferStore";
import { SaveDevice, TrustedDevices } from "./TrustedDevices";

/** Seconds until `expiresAt` (unix seconds), ticking. */
function useSecondsLeft(expiresAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (expiresAt === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);
  return expiresAt === null ? 0 : expiresAt - now / 1000;
}

/**
 * Send tab: choose documents → QR code + link → same code on both → progress;
 * or one tap on a saved device that is ready (no QR code, no code).
 */
export function SendPanel() {
  const offer = useTransfer((s) => s.offer);
  const push = useTransfer((s) => s.push);
  const send = useTransfer((s) => s.send);
  if ((!offer && !push) || !send) return <ChooseDocuments />;
  const count = offer?.docCount ?? push?.docCount ?? 0;
  switch (send.kind) {
    case "waitingForReceiver":
      return offer ? <OfferCard offer={offer} /> : <PushWaiting push={push} />;
    case "confirm":
      return <ConfirmCard code={send.code} />;
    case "sending":
      return <SendingCard bytes={send.bytes} total={send.total} route={send.route} push={push} />;
    case "interrupted":
      return <SendingCard bytes={send.bytes} total={send.total} interrupted push={push} />;
    case "done":
      return <DoneCard count={count} peer={send.trusted ? null : send.peer} />;
    case "failed":
      return <FailedCard problem={send.error} />;
  }
}

function PushWaiting({ push }: { push: Push | null }) {
  const { t } = useTranslation();
  const cancelSend = useTransfer((s) => s.cancelSend);
  return (
    <Card testId="transfer-push-waiting">
      <Busy label={t("transfer.trust.waitingFor", { name: push?.deviceName ?? "" })} testId="transfer-push-busy" />
      <Button variant="secondary" className="w-full" onClick={() => void cancelSend()} data-testid="transfer-send-cancel">
        {t("transfer.cancel")}
      </Button>
    </Card>
  );
}

function ChooseDocuments() {
  const { t, i18n } = useTranslation();
  const docs = useDocuments(ALL_DOCUMENTS);
  const selectTab = useNavigation((s) => s.selectTab);
  const preparing = useTransfer((s) => s.preparing);
  const problem = useTransfer((s) => s.sendProblem);
  const offerDocuments = useTransfer((s) => s.offerDocuments);
  const pushTo = useTransfer((s) => s.pushTo);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [history, setHistory] = useState(false);
  const historyLabel = useId();
  const list = useMemo(() => docs.data ?? [], [docs.data]);
  const chosen = list.filter((d) => selected.has(d.id));
  const size = chosen.reduce((sum, d) => sum + d.sizeBytes, 0);

  if (docs.isSuccess && list.length === 0) {
    return (
      <EmptyState
        illustration={<TransferIllustration />}
        title={t("transfer.send.emptyTitle")}
        body={t("transfer.send.emptyBody")}
        action={
          <Button variant="secondary" onClick={() => selectTab("library")}>
            {t("transfer.send.goToLibrary")}
          </Button>
        }
      />
    );
  }

  const toggle = (id: string) =>
    setSelected((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allSelected = list.length > 0 && chosen.length === list.length;

  return (
    <div className="flex flex-col gap-3" data-testid="transfer-choose">
      <div className="flex items-end justify-between gap-3">
        <div className="flex flex-col">
          <h2 className="text-[15px] font-semibold text-neutral-12">{t("transfer.send.chooseTitle")}</h2>
          <p className="text-[13px] text-neutral-11">{t("transfer.send.chooseHelp")}</p>
        </div>
        <Button
          variant="ghost"
          className="px-3"
          onClick={() => setSelected(allSelected ? new Set() : new Set(list.map((d) => d.id)))}
          data-testid="transfer-select-all"
        >
          {allSelected ? t("transfer.send.selectNone") : t("transfer.send.selectAll")}
        </Button>
      </div>
      <ul className="flex flex-col overflow-hidden rounded-[14px] border border-neutral-5 bg-surface-raised" aria-label={t("transfer.send.chooseTitle")}>
        {list.map((doc, i) => (
          <DocumentRow key={doc.id} doc={doc} checked={selected.has(doc.id)} onToggle={toggle} divider={i > 0} />
        ))}
      </ul>
      <div className="flex items-center gap-3 rounded-[14px] border border-neutral-5 bg-surface-raised py-2 pr-2 pl-4">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span id={historyLabel} className="text-md text-neutral-12">
            {t("transfer.send.includeHistory")}
          </span>
          <span className="text-[13px] text-neutral-11">{t("transfer.send.includeHistoryHelp")}</span>
        </div>
        <Switch checked={history} onChange={setHistory} labelledBy={historyLabel} testId="transfer-history" />
      </div>
      {problem ? <Problem problem={problem} testId="transfer-send-problem" /> : null}
      <TrustedDevices
        canSend={chosen.length > 0 && !preparing}
        onSend={(device) => void pushTo(device, chosen.map((d) => d.id), history)}
        testId="transfer-trusted"
      />
      <Button
        disabled={chosen.length === 0 || preparing}
        onClick={() => void offerDocuments(chosen.map((d) => d.id), history)}
        data-testid="transfer-send-start"
      >
        {preparing
          ? t("transfer.send.preparing")
          : chosen.length > 0
            ? t("transfer.send.startWith", {
                summary: t("transfer.send.summary", { count: chosen.length, size: formatBytes(size, i18n.language) }),
              })
            : t("transfer.send.start")}
      </Button>
      <MoveLibrary />
      <ExportPack selected={chosen.map((d) => d.id)} />
    </div>
  );
}

function DocumentRow({
  doc,
  checked,
  onToggle,
  divider,
}: {
  doc: Document;
  checked: boolean;
  onToggle: (id: string) => void;
  divider: boolean;
}) {
  const { t, i18n } = useTranslation();
  const title = doc.title.trim() || t("library.untitled");
  return (
    <li className={divider ? "border-t border-neutral-5" : undefined}>
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        onClick={() => onToggle(doc.id)}
        className="selis-focus flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left active:bg-neutral-3"
        data-testid="transfer-doc"
        data-doc-id={doc.id}
      >
        <span
          className={`flex size-6 shrink-0 items-center justify-center rounded-[7px] border-2 ${
            checked ? "border-accent-9 bg-accent-9 text-accent-contrast" : "border-neutral-7"
          }`}
          aria-hidden="true"
        >
          {checked ? <Check size={16} strokeWidth={3} /> : null}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-md text-neutral-12">{title}</span>
          <span className="text-[12px] text-neutral-11 tabular-nums">{formatBytes(doc.sizeBytes, i18n.language)}</span>
        </span>
      </button>
    </li>
  );
}

function OfferCard({ offer }: { offer: OfferView }) {
  const { t, i18n } = useTranslation();
  const cancelSend = useTransfer((s) => s.cancelSend);
  const secondsLeft = useSecondsLeft(offer.expiresAt);
  const src = useMemo(() => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(offer.qrSvg)}`, [offer.qrSvg]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(offer.link);
      useToast.getState().show(t("transfer.send.linkCopied"));
    } catch {
      useToast.getState().show(t("errors.generic"), "error");
    }
  };
  return (
    <Card testId="transfer-offer">
      <div className="flex flex-col items-center gap-0.5 text-center">
        <span className="text-[15px] font-semibold text-neutral-12" data-testid="transfer-offer-summary">
          {t("transfer.send.summary", { count: offer.docCount, size: formatBytes(offer.totalBytes, i18n.language) })}
        </span>
        <span className="text-[13px] text-neutral-11">{t("transfer.send.scanHelp")}</span>
      </div>
      {/* Always black on white, whatever the theme, so any camera reads it. */}
      <div className="rounded-[12px] bg-[#ffffff] p-[10px]">
        <img src={src} width={176} height={176} alt={t("transfer.send.qrAlt")} className="block size-[176px]" data-testid="transfer-qr" data-link={offer.link} />
      </div>
      <span className="text-[13px] text-neutral-11 tabular-nums" data-testid="transfer-expires">
        {t("transfer.send.expiresIn", { time: formatCountdown(secondsLeft) })}
      </span>
      <div className="flex w-full gap-2">
        <Button variant="secondary" className="flex-1" onClick={() => void copy()} data-testid="transfer-copy-link">
          {t("transfer.send.copyLink")}
        </Button>
        <Button variant="ghost" className="flex-1" onClick={() => void cancelSend()} data-testid="transfer-send-cancel">
          {t("transfer.cancel")}
        </Button>
      </div>
    </Card>
  );
}

function ConfirmCard({ code }: { code: string }) {
  const { t } = useTranslation();
  const decide = useTransfer((s) => s.decide);
  return (
    <Card testId="transfer-send-confirm">
      <CodeBlock code={code} testId="transfer-send-code" />
      <p className="text-center text-md text-neutral-11">{t("transfer.send.confirmHelp")}</p>
      <div className="flex w-full flex-col gap-2">
        <Button onClick={() => void decide(true)} data-testid="transfer-confirm">
          {t("transfer.send.confirm")}
        </Button>
        <Button variant="secondary" onClick={() => void decide(false)} data-testid="transfer-mismatch">
          {t("transfer.send.mismatch")}
        </Button>
      </div>
    </Card>
  );
}

function SendingCard({
  bytes,
  total,
  route,
  interrupted = false,
  push,
}: {
  bytes: number;
  total: number;
  route?: RouteView;
  interrupted?: boolean;
  push: Push | null;
}) {
  const { t } = useTranslation();
  const cancelSend = useTransfer((s) => s.cancelSend);
  const label = push ? t("transfer.trust.sendingTo", { name: push.deviceName }) : t("transfer.send.sending");
  return (
    <Card testId="transfer-sending">
      <Progress label={label} bytes={bytes} total={total} {...(route ? { route } : {})} testId="transfer-send-progress" />
      {interrupted ? (
        <p className="text-center text-md text-neutral-11" role="status" data-testid="transfer-send-interrupted">
          {t("transfer.send.interrupted")}
        </p>
      ) : null}
      <Button variant="secondary" className="w-full" onClick={() => void cancelSend()} data-testid="transfer-send-cancel">
        {t("transfer.cancel")}
      </Button>
    </Card>
  );
}

function DoneCard({ count, peer }: { count: number; peer: string | null }) {
  const { t } = useTranslation();
  const resetSend = useTransfer((s) => s.resetSend);
  return (
    <Card testId="transfer-send-done">
      <span className="flex size-12 items-center justify-center rounded-full bg-success-3 text-success-11" aria-hidden="true">
        <Check size={26} strokeWidth={2.5} />
      </span>
      <h2 className="text-[17px] font-semibold text-neutral-12">{t("transfer.send.doneTitle")}</h2>
      <p className="text-center text-md text-neutral-11">{t("transfer.send.doneBody", { count })}</p>
      {peer ? <SaveDevice peer={peer} /> : null}
      <Button variant="secondary" className="w-full" onClick={resetSend} data-testid="transfer-send-again">
        {t("transfer.send.again")}
      </Button>
    </Card>
  );
}

function FailedCard({ problem }: { problem: TransferProblem }) {
  const { t } = useTranslation();
  const resetSend = useTransfer((s) => s.resetSend);
  return (
    <Card testId="transfer-send-failed">
      <h2 className="text-[17px] font-semibold text-neutral-12">{t("transfer.send.failedTitle")}</h2>
      <Problem problem={problem} testId="transfer-send-problem" />
      <Button className="w-full" onClick={resetSend} data-testid="transfer-send-again">
        {problem === "expired" ? t("transfer.send.newCode") : t("transfer.retry")}
      </Button>
    </Card>
  );
}
