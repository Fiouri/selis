import type { CSSProperties } from "react";
import { Toast } from "../components/Toast";
import { TabScreen } from "../routes/TabScreen";
import { ViewerScreen } from "../routes/ViewerScreen";
import { useNavigation } from "../state/navigation";
import { TabNavigation } from "./TabNavigation";

/** Above the tab bar; on the Library also above the import button. */
function toastOffset(viewerOpen: boolean, library: boolean): string {
  if (viewerOpen) return "calc(var(--safe-bottom) + 104px)";
  return library
    ? "calc(var(--safe-bottom) + var(--tabbar-height) + 96px)"
    : "calc(var(--safe-bottom) + var(--tabbar-height) + 12px)";
}

/**
 * Phone layout: content + bottom tab bar; the viewer covers everything
 * (full-bleed) and the screen underneath stays mounted but inert.
 */
export function PhoneShell() {
  const route = useNavigation((s) => s.route);
  const viewerOpen = route.docId !== null;

  return (
    <div
      className="relative flex h-full flex-col bg-surface-app"
      data-shell="phone"
      style={{ "--fab-bottom": "calc(var(--safe-bottom) + var(--tabbar-height) + 20px)" } as CSSProperties}
    >
      <div className="flex min-h-0 flex-1 flex-col" inert={viewerOpen}>
        <main
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          style={{ paddingLeft: "var(--safe-left)", paddingRight: "var(--safe-right)" }}
        >
          <TabScreen key={route.tab} tab={route.tab} />
        </main>
        <TabNavigation orientation="horizontal" />
      </div>
      {route.docId ? (
        <div className="selis-enter absolute inset-0 z-20">
          <ViewerScreen key={route.docId} docId={route.docId} variant="phone" />
        </div>
      ) : null}
      <Toast bottomOffset={toastOffset(viewerOpen, route.tab === "library")} />
    </div>
  );
}
