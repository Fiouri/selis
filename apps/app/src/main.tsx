import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initI18n, resolveLocale } from "./i18n";
import { installNativeInsets } from "./lib/platform";
import { installHistorySync } from "./state/navigation";
import { installSettings, useSettings } from "./state/settings";
import "./styles.css";

// Startup is fully local: no network, no engine (the PDF worker starts on first open).
if (__SELIS_MOCK_IPC__) {
  const { installMockIpc } = await import("./lib/mock-ipc");
  installMockIpc();
}

installNativeInsets();
installHistorySync();
await initI18n(resolveLocale(useSettings.getState().locale, navigator.languages));
installSettings();

const root = document.getElementById("root");
if (!root) throw new Error("#root missing from index.html");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
