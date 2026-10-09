import { SegmentedControl } from "@selis/ui";
import { ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ScreenHeader } from "../components/ScreenHeader";
import type { LocalePref, ThemePref } from "../lib/api";
import { useSettings } from "../state/settings";

export function SettingsScreen() {
  const { t } = useTranslation();
  const locale = useSettings((s) => s.locale);
  const theme = useSettings((s) => s.theme);
  const setLocale = useSettings((s) => s.setLocale);
  const setTheme = useSettings((s) => s.setTheme);

  return (
    <section className="flex flex-col">
      <ScreenHeader title={t("settings.title")} />
      <div className="flex flex-col gap-6 px-4 pb-6">
        <div className="flex flex-col gap-5 rounded-card border border-neutral-5 bg-surface-raised p-4">
          <SegmentedControl<LocalePref>
            label={t("settings.language")}
            value={locale}
            testId="setting-language"
            onChange={(v) => void setLocale(v)}
            options={[
              { value: "system", label: t("settings.languageSystem") },
              { value: "el", label: t("settings.languageEl") },
              { value: "en", label: t("settings.languageEn") },
            ]}
          />
          <SegmentedControl<ThemePref>
            label={t("settings.theme")}
            value={theme}
            testId="setting-theme"
            onChange={(v) => void setTheme(v)}
            options={[
              { value: "system", label: t("settings.themeSystem") },
              { value: "light", label: t("settings.themeLight") },
              { value: "dark", label: t("settings.themeDark") },
              { value: "sepia", label: t("settings.themeSepia") },
            ]}
          />
        </div>

        <div className="flex gap-3 rounded-card border border-neutral-5 bg-surface-raised p-4">
          <ShieldCheck size={22} strokeWidth={1.75} className="mt-0.5 shrink-0 text-accent-11" aria-hidden="true" />
          <div className="flex flex-col gap-1">
            <h2 className="text-md font-semibold text-neutral-12">{t("settings.privacyTitle")}</h2>
            <p className="text-sm text-neutral-11">{t("settings.privacyBody")}</p>
          </div>
        </div>

        <p className="text-center text-xs text-neutral-11">{t("settings.version", { version: __APP_VERSION__ })}</p>
      </div>
    </section>
  );
}
