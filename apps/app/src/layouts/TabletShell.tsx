import { Toast } from "../components/Toast";
import { TabScreen } from "../routes/TabScreen";
import { ViewerScreen } from "../routes/ViewerScreen";
import { useNavigation } from "../state/navigation";
import { TabNavigation } from "./TabNavigation";

/** Basic tablet layout: navigation rail + content; documents open as thumbnails + page. */
export function TabletShell() {
  const route = useNavigation((s) => s.route);

  return (
    <div className="relative flex h-full bg-surface-app" data-shell="tablet">
      {route.docId ? null : <TabNavigation orientation="vertical" />}
      <main className="relative h-full min-w-0 flex-1 overflow-y-auto overscroll-contain" style={{ paddingRight: "var(--safe-right)" }}>
        {route.docId ? (
          <ViewerScreen key={route.docId} docId={route.docId} variant="tablet" />
        ) : (
          <div className="mx-auto w-full max-w-3xl">
            <TabScreen key={route.tab} tab={route.tab} />
          </div>
        )}
      </main>
      <Toast bottomOffset="calc(var(--safe-bottom) + 24px)" />
    </div>
  );
}
