import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleSystemBack, installHistorySync, useNavigation, useOverlay } from "./navigation";

/** jsdom's history.back() is async (fires popstate later). */
function popped(): Promise<void> {
  return new Promise((resolve) => {
    window.addEventListener("popstate", () => resolve(), { once: true });
  });
}

async function systemBack(): Promise<void> {
  const p = popped();
  history.back();
  await p;
}

let uninstall: () => void = () => undefined;

beforeEach(() => {
  uninstall();
  history.replaceState(null, "");
  useNavigation.setState({ route: { tab: "library", docId: null }, depth: 0 });
  uninstall = installHistorySync();
});

describe("navigation + back", () => {
  it("opening a document pushes an entry that back pops", async () => {
    useNavigation.getState().openDocument("doc-1");
    expect(useNavigation.getState().route).toEqual({ tab: "library", docId: "doc-1" });
    const p = popped();
    useNavigation.getState().back();
    await p;
    expect(useNavigation.getState()).toMatchObject({ route: { tab: "library", docId: null }, depth: 0 });
  });

  it("other tabs sit one step above Library; switching between them does not stack", async () => {
    useNavigation.getState().selectTab("recent");
    expect(useNavigation.getState().depth).toBe(1);
    useNavigation.getState().selectTab("settings");
    expect(useNavigation.getState()).toMatchObject({ route: { tab: "settings" }, depth: 1 });
    await systemBack();
    expect(useNavigation.getState()).toMatchObject({ route: { tab: "library", docId: null }, depth: 0 });
  });

  it("selecting Library from another tab goes back instead of pushing", async () => {
    useNavigation.getState().selectTab("transfer");
    const p = popped();
    useNavigation.getState().selectTab("library");
    await p;
    expect(useNavigation.getState()).toMatchObject({ route: { tab: "library" }, depth: 0 });
  });

  it("viewer opened from Recent returns to Recent, then Library", async () => {
    useNavigation.getState().selectTab("recent");
    useNavigation.getState().openDocument("doc-2");
    expect(useNavigation.getState()).toMatchObject({ route: { tab: "recent", docId: "doc-2" }, depth: 2 });
    await systemBack();
    expect(useNavigation.getState()).toMatchObject({ route: { tab: "recent", docId: null }, depth: 1 });
    await systemBack();
    expect(useNavigation.getState()).toMatchObject({ route: { tab: "library", docId: null }, depth: 0 });
  });

  it("re-selecting the current tab is a no-op", () => {
    const before = history.length;
    useNavigation.getState().selectTab("library");
    expect(history.length).toBe(before);
  });
});

describe("overlays (sheets, search)", () => {
  it("system back closes an open overlay before navigating", async () => {
    const onClose = vi.fn();
    const { rerender } = renderHook(({ open }) => useOverlay(open, onClose), { initialProps: { open: false } });
    rerender({ open: true });
    const entry = history.state as { depth: number; overlay?: string };
    expect(entry.depth).toBe(1);
    expect(typeof entry.overlay).toBe("string");
    expect(useNavigation.getState().depth).toBe(1);
    await act(systemBack);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(useNavigation.getState()).toMatchObject({ route: { tab: "library", docId: null }, depth: 0 });
  });

  it("closing from the UI drops the overlay entry again", async () => {
    const onClose = vi.fn();
    const { rerender } = renderHook(({ open }) => useOverlay(open, onClose), { initialProps: { open: true } });
    expect(useNavigation.getState().depth).toBe(1);
    const p = popped();
    rerender({ open: false });
    await act(() => p);
    expect(onClose).not.toHaveBeenCalled();
    expect(useNavigation.getState().depth).toBe(0);
  });

  it("an overlay opened while the previous one's entry is being popped stays open", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const a = renderHook(({ open }) => useOverlay(open, first), { initialProps: { open: true } });
    const p = popped();
    a.rerender({ open: false });
    // The release timer has run (history.back() is on its way), popstate has not arrived yet.
    await new Promise((r) => setTimeout(r, 0));
    const b = renderHook(({ open }) => useOverlay(open, second), { initialProps: { open: true } });
    await act(() => p);
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(second).not.toHaveBeenCalled();
    const entry = history.state as { depth: number; overlay?: string };
    expect(typeof entry.overlay).toBe("string");
    expect(useNavigation.getState().depth).toBe(1);

    // And back still closes it, then leaves nothing behind.
    await act(systemBack);
    expect(second).toHaveBeenCalledTimes(1);
    expect(useNavigation.getState().depth).toBe(0);
    b.unmount();
  });

  it("a document opened over an overlay comes back to it", async () => {
    const onClose = vi.fn();
    renderHook(() => useOverlay(true, onClose));
    useNavigation.getState().openDocument("doc-9");
    expect(useNavigation.getState()).toMatchObject({ route: { docId: "doc-9" }, depth: 2 });
    await act(systemBack);
    expect(onClose).not.toHaveBeenCalled();
    expect(useNavigation.getState()).toMatchObject({ route: { docId: null }, depth: 1 });
    await act(systemBack);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("Android system back (window.__selisBack)", () => {
  it("goes back inside the app, and hands over at the root", async () => {
    expect(handleSystemBack()).toBe(false);
    useNavigation.getState().openDocument("doc-7");
    const p = popped();
    expect(handleSystemBack()).toBe(true);
    await p;
    expect(useNavigation.getState()).toMatchObject({ route: { docId: null }, depth: 0 });
    expect(handleSystemBack()).toBe(false);
  });
});
