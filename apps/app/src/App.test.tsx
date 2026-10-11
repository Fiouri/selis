import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { App } from "./App";
import { i18n, initI18n } from "./i18n";
import { installMockIpc } from "./lib/mock-ipc";
import { installHistorySync } from "./state/navigation";
import { installSettings, useSettings } from "./state/settings";

beforeAll(async () => {
  installMockIpc();
  installHistorySync();
  await initI18n("en");
  installSettings();
});

describe("PhoneShell (jsdom, mock IPC)", () => {
  it("shows the empty library with one clear action and four tabs", async () => {
    window.innerWidth = 390;
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Your library is empty" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Import PDF" })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    expect(nav.querySelectorAll("button")).toHaveLength(4);
    expect(document.querySelector("[data-shell='phone']")).toBeTruthy();
  });

  it("switches language and theme from Settings", async () => {
    window.innerWidth = 390;
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    // Language is a row that opens a picker sheet.
    fireEvent.click(await screen.findByTestId("setting-language"));
    fireEvent.click(await screen.findByRole("radio", { name: "Ελληνικά" }));
    await waitFor(() => {
      expect(i18n.language).toBe("el");
    });
    expect(await screen.findByRole("heading", { name: "Ρυθμίσεις" })).toBeTruthy();
    expect(document.documentElement.lang).toBe("el");

    fireEvent.click(screen.getByRole("radio", { name: "Σέπια" }));
    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe("sepia");
    });
    await waitFor(() => {
      expect(useSettings.getState().theme).toBe("sepia");
    });

    await act(async () => {
      await useSettings.getState().setLocale("en");
      await useSettings.getState().setTheme("system");
    });
  });
});
