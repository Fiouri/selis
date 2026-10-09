import { ArrowLeftRight, Clock, LibraryBig, type LucideIcon, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { type Tab, TABS, useNavigation } from "../state/navigation";

const ICONS: Record<Tab, LucideIcon> = {
  library: LibraryBig,
  recent: Clock,
  transfer: ArrowLeftRight,
  settings: Settings,
};

type Props = { orientation: "horizontal" | "vertical" };

/** Bottom tab bar (phone) or navigation rail (tablet). */
export function TabNavigation({ orientation }: Props) {
  const { t } = useTranslation();
  const current = useNavigation((s) => s.route.tab);
  const selectTab = useNavigation((s) => s.selectTab);
  const vertical = orientation === "vertical";

  return (
    <nav
      aria-label={t("tabs.label")}
      className={
        vertical
          ? "flex h-full w-20 shrink-0 flex-col items-center gap-2 border-r border-neutral-5 bg-neutral-2"
          : "shrink-0 border-t border-neutral-5 bg-neutral-2"
      }
      style={
        vertical
          ? { paddingTop: "calc(var(--safe-top) + 16px)", paddingLeft: "var(--safe-left)" }
          : { paddingBottom: "var(--safe-bottom)", paddingLeft: "var(--safe-left)", paddingRight: "var(--safe-right)" }
      }
    >
      <ul className={vertical ? "flex flex-col gap-2" : "grid h-(--tabbar-height) grid-cols-4"}>
        {TABS.map((tab) => {
          const Icon = ICONS[tab];
          const active = tab === current;
          return (
            <li key={tab} className="flex">
              <button
                type="button"
                aria-current={active ? "page" : undefined}
                onClick={() => selectTab(tab)}
                className={`selis-focus group flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 ${
                  vertical ? "w-20 py-1" : ""
                } ${active ? "text-accent-11" : "text-neutral-11"}`}
              >
                <span
                  className={`flex h-8 w-14 items-center justify-center rounded-full transition-colors duration-150 ease-standard ${
                    active ? "bg-accent-3" : "group-hover:bg-neutral-3"
                  }`}
                >
                  <Icon size={20} strokeWidth={active ? 2 : 1.75} aria-hidden="true" />
                </span>
                <span className={`text-xs ${active ? "font-semibold" : "font-medium"}`}>{t(`tabs.${tab}`)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
