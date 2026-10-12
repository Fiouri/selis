import { cx } from "@selis/ui";
import { Lock } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { RouteView } from "../../lib/api";
import { formatBytes, formatCode, percent } from "./format";
import type { TransferProblem } from "./transferStore";

export function Card({ children, testId, className }: { children: ReactNode; testId?: string; className?: string }) {
  return (
    <div
      className={cx("flex flex-col items-center gap-4 rounded-[16px] border border-neutral-5 bg-surface-raised p-5", className)}
      data-testid={testId}
    >
      {children}
    </div>
  );
}

/** "Κωδικός επιβεβαίωσης" 12 px + the code 30 px / 700 / .08em, tabular (brief §5). */
export function CodeBlock({ code, testId }: { code: string; testId: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-[12px] font-medium text-neutral-11">{t("transfer.codeLabel")}</span>
      <span
        className="text-[30px] leading-tight font-bold tracking-[0.08em] text-neutral-12 tabular-nums"
        data-testid={testId}
        // Screen readers say the digits one by one.
        aria-label={`${t("transfer.codeLabel")}: ${code.split("").join(" ")}`}
      >
        {formatCode(code)}
      </span>
    </div>
  );
}

/** Which way the bytes go: 32 px chip (brief §5). */
export function RouteChip({ route }: { route: RouteView }) {
  const { t } = useTranslation();
  const direct = route === "lan" || route === "direct";
  return (
    <span
      className={cx(
        "inline-flex h-8 items-center rounded-full px-3 text-[13px] font-semibold",
        direct ? "bg-success-3 text-success-11" : "bg-neutral-3 text-neutral-11",
      )}
      data-testid="transfer-route"
      data-route={route}
    >
      {t(`transfer.route.${route}`)}
    </span>
  );
}

export function Progress({
  label,
  bytes,
  total,
  route,
  testId,
}: {
  label: string;
  bytes: number;
  total: number;
  route?: RouteView;
  testId: string;
}) {
  const { t, i18n } = useTranslation();
  const pct = percent(bytes, total);
  return (
    <div className="flex w-full flex-col gap-2" data-testid={testId}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-md font-semibold text-neutral-12">{label}</span>
        <span className="text-[13px] text-neutral-11 tabular-nums">{t("transfer.percent", { percent: pct })}</span>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-neutral-4"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div className="h-full rounded-full bg-accent-9 transition-[width] duration-300" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[13px] text-neutral-11 tabular-nums">
        {t("transfer.progress", {
          done: formatBytes(bytes, i18n.language),
          total: formatBytes(total, i18n.language),
        })}
      </span>
      {route ? (
        <div className="flex justify-center pt-1">
          <RouteChip route={route} />
        </div>
      ) : null}
    </div>
  );
}

export function Problem({ problem, testId }: { problem: TransferProblem; testId: string }) {
  const { t } = useTranslation();
  return (
    <p role="alert" className="text-center text-md text-danger-11" data-testid={testId} data-problem={problem}>
      {t(`transfer.error.${problem}`)}
    </p>
  );
}

export function Busy({ label, testId }: { label: string; testId: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-2" role="status" data-testid={testId}>
      <span
        className="size-8 animate-spin rounded-full border-[3px] border-neutral-5 border-t-accent-9 motion-reduce:animate-none"
        aria-hidden="true"
      />
      <span className="text-md text-neutral-11">{label}</span>
    </div>
  );
}

export function LockFooter() {
  const { t } = useTranslation();
  return (
    <p className="flex items-center justify-center gap-2 px-4 py-4 text-center text-[13px] text-neutral-11">
      <Lock size={14} strokeWidth={2} aria-hidden="true" className="shrink-0" />
      {t("transfer.lockFooter")}
    </p>
  );
}
