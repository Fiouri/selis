/**
 * The viewer's password prompt for a protected document (P4a; docs/design/p4-ui-brief.md §3).
 * The password goes straight to the engine and is not kept.
 */
import { Button } from "@selis/ui";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sheet } from "../../components/Sheet";

export function UnlockSheet({
  open,
  wrong,
  onUnlock,
  onBack,
}: {
  open: boolean;
  wrong: boolean;
  onUnlock: (password: string) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const [pass, setPass] = useState("");
  const inputId = useId();
  const alertId = useId();
  return (
    <Sheet open={open} onClose={onBack} title={t("tools.unlockTitle")} testId="unlock-sheet">
      <form
        className="flex flex-col gap-3 px-5 pb-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (pass.length === 0) return;
          const value = pass;
          setPass("");
          onUnlock(value);
        }}
      >
        <label htmlFor={inputId} className="text-[13px] font-medium text-neutral-11">
          {t("tools.password")}
        </label>
        <input
          id={inputId}
          type="password"
          autoComplete="current-password"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          aria-describedby={wrong ? alertId : undefined}
          className="selis-focus h-12 w-full rounded-control border border-neutral-6 bg-surface-app px-3 text-md text-neutral-12"
          data-testid="unlock-password"
        />
        {wrong ? (
          <p id={alertId} role="alert" className="text-[13px] text-danger-11" data-testid="unlock-wrong">
            {t("tools.wrongPassword")}
          </p>
        ) : null}
        <Button type="submit" disabled={pass.length === 0} data-testid="unlock-submit">
          {t("tools.unlock")}
        </Button>
        <Button type="button" variant="secondary" onClick={onBack} data-testid="unlock-back">
          {t("viewer.back")}
        </Button>
      </form>
    </Sheet>
  );
}
