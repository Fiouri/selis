import { Switch } from "@selis/ui";
import { Check, ChevronRight } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScreenHeader } from "../components/ScreenHeader";
import { Sheet } from "../components/Sheet";
import type { LocalePref, ThemePref } from "../lib/api";
import { useSettings } from "../state/settings";

const THEMES: ReadonlyArray<{ value: ThemePref; key: string; swatch: string; accent: string }> = [
  {
    value: "system",
    key: "settings.themeSystem",
    swatch: "linear-gradient(90deg, var(--swatch-light) 50%, var(--swatch-dark) 50%)",
    accent: "var(--swatch-light-accent)",
  },
  { value: "light", key: "settings.themeLight", swatch: "var(--swatch-light)", accent: "var(--swatch-light-accent)" },
  { value: "dark", key: "settings.themeDark", swatch: "var(--swatch-dark)", accent: "var(--swatch-dark-accent)" },
  { value: "sepia", key: "settings.themeSepia", swatch: "var(--swatch-sepia)", accent: "var(--swatch-sepia-accent)" },
];

const LANGUAGES: ReadonlyArray<{ value: LocalePref; key: string }> = [
  { value: "system", key: "settings.languageSystem" },
  { value: "el", key: "settings.languageEl" },
  { value: "en", key: "settings.languageEn" },
];

/** Picker values (the backend accepts any value in range). */
const VERSION_CHOICES = [5, 10, 20, 50] as const;
const HISTORY_CHOICES_MB = [50, 100, 200, 500, 1000] as const;

const NEXT_KEYS = new Set(["ArrowRight", "ArrowDown"]);
const PREV_KEYS = new Set(["ArrowLeft", "ArrowUp"]);

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col">
      <h2 className="mt-5 mb-2 text-[13px] font-semibold text-neutral-11">{title}</h2>
      <div className="flex flex-col rounded-[14px] border border-neutral-5 bg-surface-raised">{children}</div>
    </section>
  );
}

const Divider = () => <div className="mx-4 h-px bg-neutral-5" aria-hidden="true" />;

/** 2×2 radiogroup (Σύστημα, Φωτεινό, Σκούρο, Σέπια) with mini swatches; applies at once. */
function ThemeTiles() {
  const { t } = useTranslation();
  const theme = useSettings((s) => s.theme);
  const setTheme = useSettings((s) => s.setTheme);
  const labelId = useId();

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = NEXT_KEYS.has(event.key) ? 1 : PREV_KEYS.has(event.key) ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const index = THEMES.findIndex((o) => o.value === theme);
    const next = THEMES[(index + step + THEMES.length) % THEMES.length];
    if (!next) return;
    void setTheme(next.value);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-value="${next.value}"]`)?.focus();
  };

  return (
    <div className="flex flex-col gap-3 p-4">
      <span id={labelId} className="text-md font-medium text-neutral-12">
        {t("settings.theme")}
      </span>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        onKeyDown={onKeyDown}
        className="grid grid-cols-2 gap-2"
        data-testid={`theme-choice-${theme}`}
      >
        {THEMES.map((option) => {
          const selected = option.value === theme;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              data-value={option.value}
              onClick={() => void setTheme(option.value)}
              className={`selis-focus flex h-13 items-center gap-3 rounded-card px-3 text-left text-sm transition-colors duration-150 ease-standard ${
                selected
                  ? "bg-accent-3 font-semibold text-accent-selected shadow-[inset_0_0_0_2px_var(--accent-9)]"
                  : "border border-neutral-5 font-medium text-neutral-12 active:bg-neutral-3"
              }`}
            >
              <span
                aria-hidden="true"
                className="relative h-[22px] w-[30px] shrink-0 rounded-[6px] border border-neutral-6"
                style={{ background: option.swatch }}
              >
                <span className="absolute right-[3px] bottom-[3px] size-2 rounded-full" style={{ background: option.accent }} />
              </span>
              <span className="min-w-0 truncate">{t(option.key)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ValueRow({ label, value, onClick, testId }: { label: string; value: string; onClick: () => void; testId?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-haspopup="dialog"
      data-testid={testId}
      className="selis-focus flex min-h-13 w-full items-center gap-3 px-4 text-left active:bg-neutral-3"
    >
      <span className="flex-1 text-md text-neutral-12">{label}</span>
      <span className="text-md text-neutral-11 tabular-nums">{value}</span>
      <ChevronRight size={20} strokeWidth={1.75} className="text-neutral-9" aria-hidden="true" />
    </button>
  );
}

function SwitchRow({
  label,
  helper,
  checked,
  onChange,
  disabled = false,
  badge,
  testId,
}: {
  label: string;
  helper: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  badge?: string;
  testId?: string;
}) {
  const labelId = useId();
  const helperId = useId();
  return (
    <div className="flex items-center gap-3 py-2 pr-2 pl-4">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span id={labelId} className={`flex items-center gap-2 text-md ${disabled ? "text-neutral-11" : "text-neutral-12"}`}>
          {label}
          {badge ? (
            <span className="rounded-full bg-neutral-3 px-2 py-0.5 text-[11px] font-semibold text-neutral-11">{badge}</span>
          ) : null}
        </span>
        <span id={helperId} className="text-[13px] text-neutral-11">
          {helper}
        </span>
      </div>
      <Switch checked={checked} onChange={onChange} labelledBy={labelId} describedBy={helperId} disabled={disabled} testId={testId} />
    </div>
  );
}

type Choice<T> = { value: T; label: string };

/** One-choice list in a bottom sheet; choosing applies and closes. */
function ChoiceSheet<T extends string | number>({
  open,
  title,
  choices,
  value,
  onChoose,
  onClose,
  testId,
}: {
  open: boolean;
  title: string;
  choices: ReadonlyArray<Choice<T>>;
  value: T;
  onChoose: (value: T) => void;
  onClose: () => void;
  testId: string;
}) {
  return (
    <Sheet open={open} onClose={onClose} title={title} testId={testId}>
      <div role="radiogroup" aria-label={title} className="flex flex-col pb-2">
        {choices.map((choice) => {
          const selected = choice.value === value;
          return (
            <button
              key={String(choice.value)}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => {
                onChoose(choice.value);
                onClose();
              }}
              className={`selis-focus flex min-h-12 items-center justify-between px-5 text-left text-md active:bg-neutral-3 ${
                selected ? "font-semibold text-accent-selected" : "text-neutral-12"
              }`}
            >
              {choice.label}
              {selected ? <Check size={20} strokeWidth={2} aria-hidden="true" /> : null}
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}

type Picker = "language" | "versions" | "history" | null;

/** Settings per docs/design/p1-ui-brief.md §6. Every change applies at once and persists. */
export function SettingsScreen() {
  const { t } = useTranslation();
  const locale = useSettings((s) => s.locale);
  const localOnly = useSettings((s) => s.localOnly);
  const versions = useSettings((s) => s.versionsPerDocument);
  const historyMb = useSettings((s) => s.historyLimitMb);
  const appLock = useSettings((s) => s.appLock);
  const setLocale = useSettings((s) => s.setLocale);
  const setPreference = useSettings((s) => s.setPreference);
  const [picker, setPicker] = useState<Picker>(null);
  const close = () => setPicker(null);

  const languageLabel = t(LANGUAGES.find((l) => l.value === locale)?.key ?? "settings.languageSystem");

  return (
    <section className="flex flex-col" data-testid="settings-screen">
      <ScreenHeader title={t("settings.title")} />
      <div className="flex flex-col px-5 pb-8">
        <Section title={t("settings.appearance")}>
          <ThemeTiles />
          <Divider />
          <ValueRow label={t("settings.language")} value={languageLabel} onClick={() => setPicker("language")} testId="setting-language" />
        </Section>

        <Section title={t("settings.transfer")}>
          <SwitchRow
            label={t("settings.localOnly")}
            helper={t("settings.localOnlyHelp")}
            checked={localOnly}
            onChange={(on) => void setPreference("localOnly", on)}
            testId="setting-local-only"
          />
        </Section>

        <Section title={t("settings.storage")}>
          <ValueRow
            label={t("settings.versionsPerDocument")}
            value={String(versions)}
            onClick={() => setPicker("versions")}
            testId="setting-versions"
          />
          <Divider />
          <ValueRow
            label={t("settings.historyLimit")}
            value={t("settings.megabytes", { mb: historyMb })}
            onClick={() => setPicker("history")}
            testId="setting-history"
          />
        </Section>

        <Section title={t("settings.security")}>
          <SwitchRow
            label={t("settings.appLock")}
            helper={t("settings.appLockHelp")}
            checked={appLock}
            onChange={(on) => void setPreference("appLock", on)}
            disabled
            badge={t("settings.soon")}
            testId="setting-app-lock"
          />
        </Section>

        <p className="mt-8 text-center text-xs text-neutral-11">{t("settings.footer", { version: __APP_VERSION__ })}</p>
      </div>

      <ChoiceSheet
        open={picker === "language"}
        title={t("settings.language")}
        choices={LANGUAGES.map((l) => ({ value: l.value, label: t(l.key) }))}
        value={locale}
        onChoose={(v) => void setLocale(v)}
        onClose={close}
        testId="language-sheet"
      />
      <ChoiceSheet
        open={picker === "versions"}
        title={t("settings.versionsPerDocument")}
        choices={VERSION_CHOICES.map((n): Choice<number> => ({ value: n, label: String(n) }))}
        value={versions}
        onChoose={(v) => void setPreference("versionsPerDocument", v)}
        onClose={close}
        testId="versions-sheet"
      />
      <ChoiceSheet
        open={picker === "history"}
        title={t("settings.historyLimit")}
        choices={HISTORY_CHOICES_MB.map((mb): Choice<number> => ({ value: mb, label: t("settings.megabytes", { mb }) }))}
        value={historyMb}
        onChoose={(v) => void setPreference("historyLimitMb", v)}
        onClose={close}
        testId="history-sheet"
      />
    </section>
  );
}
