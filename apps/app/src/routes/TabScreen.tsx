import type { Tab } from "../state/navigation";
import { LibraryScreen } from "./LibraryScreen";
import { RecentScreen } from "./RecentScreen";
import { SettingsScreen } from "./SettingsScreen";
import { TransferScreen } from "./TransferScreen";

export function TabScreen({ tab, activeId = null }: { tab: Tab; activeId?: string | null }) {
  switch (tab) {
    case "library":
      return <LibraryScreen activeId={activeId} />;
    case "recent":
      return <RecentScreen activeId={activeId} />;
    case "transfer":
      return <TransferScreen />;
    case "settings":
      return <SettingsScreen />;
  }
}
