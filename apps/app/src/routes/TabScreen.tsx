import type { Tab } from "../state/navigation";
import { LibraryScreen } from "./LibraryScreen";
import { RecentScreen } from "./RecentScreen";
import { SettingsScreen } from "./SettingsScreen";
import { TransferScreen } from "./TransferScreen";

export function TabScreen({ tab }: { tab: Tab }) {
  switch (tab) {
    case "library":
      return <LibraryScreen />;
    case "recent":
      return <RecentScreen />;
    case "transfer":
      return <TransferScreen />;
    case "settings":
      return <SettingsScreen />;
  }
}
