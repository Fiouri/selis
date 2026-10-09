import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { I18nextProvider } from "react-i18next";
import { i18n } from "./i18n";
import { DesktopShell } from "./layouts/DesktopShell";
import { PhoneShell } from "./layouts/PhoneShell";
import { TabletShell } from "./layouts/TabletShell";
import { chooseShell, platform, type ShellKind } from "./lib/platform";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
    mutations: { retry: 0 },
  },
});

function subscribeResize(callback: () => void): () => void {
  window.addEventListener("resize", callback);
  return () => window.removeEventListener("resize", callback);
}

/** Shell follows platform + viewport width (re-evaluated on resize/rotation). */
export function useShellKind(): ShellKind {
  return useSyncExternalStore(subscribeResize, () => chooseShell(platform, window.innerWidth));
}

export function App() {
  const shell = useShellKind();
  return (
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        {shell === "phone" ? <PhoneShell /> : shell === "tablet" ? <TabletShell /> : <DesktopShell />}
      </I18nextProvider>
    </QueryClientProvider>
  );
}
