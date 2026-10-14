/**
 * Tools (P4a; docs/design/p4-ui-brief.md §1–4): the Tools sheet and the password sheets for
 * the document `useTools` holds. Mounted once (App); the viewer's ⋮ sheet and the library's
 * document menu open it with `useTools.getState().open(id, onSaved)`.
 */
import { exportPixels } from "@selis/engine";
import { Button, Switch } from "@selis/ui";
import { Check, ChevronDown, ChevronRight, Gauge, Image, LockKeyhole, LockKeyholeOpen, Shrink, Wrench } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sheet } from "../../components/Sheet";
import { useToast } from "../../components/Toast";
import { currentRenderLimits } from "../../lib/engine";
import { formatBytes } from "../transfer/format";
import { Busy, Card } from "../transfer/parts";
import { EXPORT_DPIS, type ExportDpi, type ExportFormat, MAX_PASSWORD_BYTES, MIN_PASSWORD, passwordBytes, useTools } from "./toolsStore";

const row =
  "selis-focus flex min-h-14 w-full items-center gap-4 px-5 py-2 text-left text-md text-neutral-12 active:bg-neutral-3 disabled:active:bg-transparent";
const field =
  "selis-focus h-12 w-full rounded-control border border-neutral-6 bg-surface-app px-3 text-md text-neutral-12";
const icon = (Icon: typeof Wrench) => <Icon size={22} strokeWidth={1.75} className="text-neutral-11" aria-hidden="true" />;
/** Rows block height (6 rows): the busy state keeps it, so the sheet does not jump. */
const ROWS_MIN_HEIGHT = "min-h-[352px]";

function ToolRow({
  label,
  reason,
  glyph,
  onClick,
  chevron,
  testId,
}: {
  label: string;
  reason: string | null;
  glyph: ReactNode;
  onClick: () => void;
  chevron: boolean;
  testId: string;
}) {
  const reasonId = useId();
  return (
    <li>
      <button
        type="button"
        className={row}
        disabled={reason !== null}
        aria-describedby={reason ? reasonId : undefined}
        onClick={onClick}
        data-testid={testId}
      >
        {glyph}
        <span className={`flex min-w-0 flex-1 flex-col ${reason ? "opacity-60" : ""}`}>
          <span>{label}</span>
          {reason ? (
            <span id={reasonId} className="text-[13px] text-neutral-11">
              {reason}
            </span>
          ) : null}
        </span>
        {chevron ? <ChevronRight size={20} strokeWidth={1.75} className="text-neutral-9" aria-hidden="true" /> : null}
      </button>
    </li>
  );
}

function ToolsMenu() {
  const { t } = useTranslation();
  const protection = useTools((s) => s.protection);
  const view = useTools((s) => s.view);
  const hasPage = useTools((s) => s.page !== null);
  const show = useTools((s) => s.show);
  const run = useTools((s) => s.run);
  const close = useTools((s) => s.close);
  const { i18n } = useTranslation();

  if (view.step === "running" || protection === null) {
    return (
      <div className={`flex items-center justify-center px-5 ${ROWS_MIN_HEIGHT}`}>
        <Busy label={t(protection === null ? "tools.loading" : "tools.working")} testId="tools-busy" />
      </div>
    );
  }
  if (view.step === "compressed" || view.step === "notSmaller") {
    const done = (
      <Button className="w-full" onClick={close} data-testid="tools-done">
        {t("tools.done")}
      </Button>
    );
    return (
      <div className={`flex flex-col justify-center px-5 pb-5 ${ROWS_MIN_HEIGHT}`}>
        {view.step === "compressed" ? (
          <Card testId="tools-compressed">
            <h2 className="text-[17px] font-semibold text-neutral-12">{t("tools.compressedTitle")}</h2>
            <p className="text-center text-md text-neutral-11 tabular-nums" data-testid="tools-sizes">
              {t("tools.compressedBody", {
                before: formatBytes(view.inputBytes, i18n.language),
                after: formatBytes(view.outputBytes, i18n.language),
                percent: Math.round((1 - view.outputBytes / view.inputBytes) * 100),
              })}
            </p>
            {done}
          </Card>
        ) : (
          <Card testId="tools-not-smaller">
            <p className="text-center text-md text-neutral-11">{t("tools.notSmaller")}</p>
            {done}
          </Card>
        )}
      </div>
    );
  }
  const locked = protection === "password";
  const lockedReason = locked ? t("tools.reasonLocked") : null;
  return (
    <ul className={`flex flex-col pt-1 pb-2 ${ROWS_MIN_HEIGHT}`} data-testid="tools-rows">
      <ToolRow
        label={t("tools.protect")}
        reason={locked ? t("tools.reasonProtected") : null}
        glyph={icon(LockKeyhole)}
        onClick={() => show({ step: "protect" })}
        chevron
        testId="tool-protect"
      />
      <ToolRow
        label={t("tools.unprotect")}
        reason={locked ? null : t("tools.reasonNoPassword")}
        glyph={icon(LockKeyholeOpen)}
        onClick={() => show({ step: "unprotect", wrong: false })}
        chevron
        testId="tool-unprotect"
      />
      <ToolRow
        label={t("tools.compress")}
        reason={lockedReason}
        glyph={icon(Shrink)}
        onClick={() => void run({ kind: "compress" })}
        chevron={false}
        testId="tool-compress"
      />
      <ToolRow
        label={t("tools.linearize")}
        reason={lockedReason}
        glyph={icon(Gauge)}
        onClick={() => void run({ kind: "linearize" })}
        chevron={false}
        testId="tool-linearize"
      />
      <ToolRow
        label={t("tools.repair")}
        reason={lockedReason}
        glyph={icon(Wrench)}
        onClick={() => void run({ kind: "repair" })}
        chevron={false}
        testId="tool-repair"
      />
      <ToolRow
        label={t("tools.exportImage")}
        reason={hasPage ? null : t("tools.reasonNoPage")}
        glyph={icon(Image)}
        onClick={() => show({ step: "export" })}
        chevron
        testId="tool-export-image"
      />
    </ul>
  );
}

function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  testId,
  describedBy,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: "new-password" | "current-password";
  testId: string;
  describedBy?: string | undefined;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-[13px] font-medium text-neutral-11">
        {label}
      </label>
      <input
        id={id}
        type="password"
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={describedBy}
        className={field}
        data-testid={testId}
      />
    </div>
  );
}

function SwitchRow({ label, checked, onChange, testId }: { label: string; checked: boolean; onChange: (v: boolean) => void; testId: string }) {
  const labelId = useId();
  return (
    <div className="flex min-h-12 items-center gap-3">
      <span id={labelId} className="flex-1 text-md text-neutral-12">
        {label}
      </span>
      <Switch checked={checked} onChange={onChange} labelledBy={labelId} testId={testId} />
    </div>
  );
}

function ProtectSheet() {
  const { t } = useTranslation();
  const open = useTools((s) => s.view.step === "protect" && s.docId !== null);
  const show = useTools((s) => s.show);
  return (
    <Sheet open={open} onClose={() => show({ step: "menu" })} title={t("tools.protectTitle")} testId="tools-protect-sheet">
      {/* Mounted only while open: nothing typed outlives the sheet. */}
      {open ? <ProtectForm /> : null}
    </Sheet>
  );
}

function ProtectForm() {
  const { t } = useTranslation();
  const run = useTools((s) => s.run);
  const [pass, setPass] = useState("");
  const [again, setAgain] = useState("");
  const [owner, setOwner] = useState("");
  const [restrict, setRestrict] = useState(false);
  const [print, setPrint] = useState(true);
  const [copy, setCopy] = useState(true);
  const [modify, setModify] = useState(true);
  const alertId = useId();

  const restricted = restrict && !(print && copy && modify);
  let problem: string | null = null;
  if (pass.length > 0 && pass.length < MIN_PASSWORD) problem = t("tools.tooShort", { count: MIN_PASSWORD });
  else if (passwordBytes(pass) > MAX_PASSWORD_BYTES) problem = t("tools.tooLong");
  else if (again.length > 0 && again !== pass) problem = t("tools.mismatch");
  else if (restricted && owner.length > 0 && owner === pass) problem = t("tools.ownerSame");
  else if (restricted && owner.length > 0 && owner.length < MIN_PASSWORD) problem = t("tools.tooShort", { count: MIN_PASSWORD });
  else if (passwordBytes(owner) > MAX_PASSWORD_BYTES) problem = t("tools.tooLong");
  const valid =
    problem === null && pass.length >= MIN_PASSWORD && again === pass && (!restricted || owner.length >= MIN_PASSWORD);

  return (
    <form
      className="flex flex-col gap-3 px-5 pb-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        const request = {
          kind: "protect" as const,
          password: pass,
          ownerPassword: restricted ? owner : null,
          allowPrint: restricted ? print : true,
          allowCopy: restricted ? copy : true,
          allowModify: restricted ? modify : true,
        };
        setPass("");
        setAgain("");
        setOwner("");
        void run(request);
      }}
    >
      <PasswordField label={t("tools.password")} value={pass} onChange={setPass} autoComplete="new-password" testId="tools-password" describedBy={problem ? alertId : undefined} />
      <PasswordField label={t("tools.passwordAgain")} value={again} onChange={setAgain} autoComplete="new-password" testId="tools-password-again" />
      <button
        type="button"
        className="selis-focus flex min-h-12 items-center gap-3 text-left text-md text-neutral-12"
        aria-expanded={restrict}
        onClick={() => setRestrict(!restrict)}
        data-testid="tools-restrictions"
      >
        <span className="flex-1">{t("tools.restrictions")}</span>
        <ChevronDown
          size={20}
          strokeWidth={1.75}
          className={`text-neutral-9 transition-transform duration-200 ease-standard ${restrict ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>
      {restrict ? (
        <div className="flex flex-col gap-1 rounded-[14px] border border-neutral-5 px-4 py-2" data-testid="tools-restrictions-group">
          <SwitchRow label={t("tools.allowPrint")} checked={print} onChange={setPrint} testId="tools-allow-print" />
          <SwitchRow label={t("tools.allowCopy")} checked={copy} onChange={setCopy} testId="tools-allow-copy" />
          <SwitchRow label={t("tools.allowModify")} checked={modify} onChange={setModify} testId="tools-allow-modify" />
          {restricted ? (
            <>
              <PasswordField label={t("tools.ownerPassword")} value={owner} onChange={setOwner} autoComplete="new-password" testId="tools-owner-password" />
              <p className="pb-1 text-[13px] text-neutral-11">{t("tools.ownerHelp")}</p>
            </>
          ) : null}
        </div>
      ) : null}
      {problem ? (
        <p id={alertId} role="alert" className="text-[13px] text-danger-11" data-testid="tools-password-problem">
          {problem}
        </p>
      ) : null}
      <p className="text-[13px] text-warning-11">{t("tools.noRecovery")}</p>
      <Button type="submit" disabled={!valid} data-testid="tools-protect-submit">
        {t("tools.protectAction")}
      </Button>
    </form>
  );
}

function UnprotectSheet() {
  const { t } = useTranslation();
  const open = useTools((s) => s.view.step === "unprotect" && s.docId !== null);
  const show = useTools((s) => s.show);
  return (
    <Sheet open={open} onClose={() => show({ step: "menu" })} title={t("tools.unprotectTitle")} testId="tools-unprotect-sheet">
      {open ? <UnprotectForm /> : null}
    </Sheet>
  );
}

function UnprotectForm() {
  const { t } = useTranslation();
  const wrong = useTools((s) => s.view.step === "unprotect" && s.view.wrong);
  const run = useTools((s) => s.run);
  const [pass, setPass] = useState("");
  const alertId = useId();
  return (
    <form
      className="flex flex-col gap-3 px-5 pb-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (pass.length === 0) return;
        const password = pass;
        setPass("");
        void run({ kind: "unprotect", password });
      }}
    >
      <PasswordField
        label={t("tools.currentPassword")}
        value={pass}
        onChange={setPass}
        autoComplete="current-password"
        testId="tools-current-password"
        describedBy={wrong ? alertId : undefined}
      />
      {wrong ? (
        <p id={alertId} role="alert" className="text-[13px] text-danger-11" data-testid="tools-wrong-password">
          {t("tools.wrongPassword")}
        </p>
      ) : null}
      <Button type="submit" disabled={pass.length === 0} data-testid="tools-unprotect-submit">
        {t("tools.unprotectAction")}
      </Button>
    </form>
  );
}

function RadioRows<T extends string | number>({
  label,
  options,
  value,
  onChange,
  testId,
}: {
  label: string;
  options: readonly { value: T; label: string; note: string | null; disabled: boolean }[];
  value: T;
  onChange: (value: T) => void;
  testId: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[13px] font-medium text-neutral-11">{label}</span>
      <div role="radiogroup" aria-label={label} className="flex flex-col overflow-hidden rounded-[14px] border border-neutral-5" data-testid={testId}>
        {options.map((option, i) => (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={value === option.value}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            className={`selis-focus flex min-h-12 items-center justify-between gap-3 px-4 text-left text-md text-neutral-12 disabled:opacity-50 ${i > 0 ? "border-t border-neutral-5" : ""}`}
            data-testid={`${testId}-${String(option.value)}`}
          >
            <span className="flex flex-col">
              <span>{option.label}</span>
              {option.note ? <span className="text-[13px] text-neutral-11">{option.note}</span> : null}
            </span>
            {value === option.value ? <Check size={20} strokeWidth={2} aria-hidden="true" className="text-accent-11" /> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

function ExportSheet() {
  const { t } = useTranslation();
  const step = useTools((s) => s.view.step);
  const page = useTools((s) => s.page);
  const show = useTools((s) => s.show);
  const exportPage = useTools((s) => s.exportPage);
  const open = page !== null && (step === "export" || step === "exporting");
  const [format, setFormat] = useState<ExportFormat>("png");
  const [chosen, setDpi] = useState<ExportDpi | null>(null);
  const size = page ? page.doc.pages[page.page] : undefined;
  const maxPixels = currentRenderLimits().maxBitmapPixels;
  const fits = (dpi: ExportDpi) => {
    if (!size) return false;
    const px = exportPixels(size, dpi);
    return px.width * px.height <= maxPixels;
  };
  const best = [...EXPORT_DPIS].reverse().find((d) => d <= 150 && fits(d)) ?? EXPORT_DPIS[0];
  const dpi = chosen !== null && fits(chosen) ? chosen : best;
  const px = size ? exportPixels(size, dpi) : null;
  const dpiLabel = { 96: "tools.dpi96", 150: "tools.dpi150", 300: "tools.dpi300" } as const;
  return (
    <Sheet open={open} onClose={() => show({ step: "menu" })} title={t("tools.exportTitle")} testId="tools-export-sheet">
      <div className="flex flex-col gap-3 px-5 pb-5">
        <RadioRows
          label={t("tools.format")}
          options={[
            { value: "png" as const, label: t("tools.png"), note: null, disabled: false },
            { value: "jpeg" as const, label: t("tools.jpeg"), note: null, disabled: false },
          ]}
          value={format}
          onChange={setFormat}
          testId="tools-format"
        />
        <RadioRows
          label={t("tools.resolution")}
          options={EXPORT_DPIS.map((d) => ({
            value: d,
            label: t(dpiLabel[d]),
            note: fits(d) ? null : t("tools.tooLargeHere"),
            disabled: !fits(d),
          }))}
          value={dpi}
          onChange={setDpi}
          testId="tools-dpi"
        />
        {page && px ? (
          <p className="text-[13px] text-neutral-11 tabular-nums" data-testid="tools-export-pixels">
            {t("tools.pixels", { page: page.page + 1, width: px.width, height: px.height })}
          </p>
        ) : null}
        {step === "exporting" ? (
          <div className="flex h-12 items-center justify-center">
            <Busy label={t("tools.exporting")} testId="tools-exporting" />
          </div>
        ) : (
          <Button onClick={() => void exportPage(format, dpi)} data-testid="tools-export-save">
            {t("tools.save")}
          </Button>
        )}
      </div>
    </Sheet>
  );
}

/** Mounted once: the Tools sheet, its password sheets, and its notices as toasts. */
export function ToolsSheets() {
  const { t } = useTranslation();
  const docId = useTools((s) => s.docId);
  const step = useTools((s) => s.view.step);
  const close = useTools((s) => s.close);
  const notice = useTools((s) => s.notice);

  // Each notice once (`seq` grows with every one, also when the same one repeats).
  const shown = useRef(0);
  useEffect(() => {
    if (!notice || notice.seq === shown.current) return;
    shown.current = notice.seq;
    useToast.getState().show(t(`tools.notice.${notice.key}`), notice.error ? "error" : "info");
  }, [notice, t]);

  const menuOpen = docId !== null && step !== "protect" && step !== "unprotect" && step !== "export" && step !== "exporting";
  return (
    <>
      <Sheet open={menuOpen} onClose={close} title={t("tools.title")} testId="tools-sheet">
        <ToolsMenu />
      </Sheet>
      <ProtectSheet />
      <UnprotectSheet />
      <ExportSheet />
    </>
  );
}
