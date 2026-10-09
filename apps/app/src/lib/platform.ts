/** Platform detection, shell selection and native (Android) integration. */

export type Platform = "android" | "ios" | "desktop";
export type ShellKind = "phone" | "tablet" | "desktop";

export const PHONE_MAX_WIDTH = 600;
export const TABLET_MAX_WIDTH = 1024;

export function detectPlatform(userAgent: string, maxTouchPoints: number): Platform {
  if (/Android/i.test(userAgent)) return "android";
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "ios";
  // iPadOS reports a desktop Safari UA; touch support gives it away.
  if (/Macintosh/i.test(userAgent) && maxTouchPoints > 1) return "ios";
  return "desktop";
}

/**
 * Mobile platforms never get the desktop shell; desktop windows fall back to
 * the tablet/phone shells when narrow.
 */
export function chooseShell(platform: Platform, viewportWidth: number): ShellKind {
  if (viewportWidth < PHONE_MAX_WIDTH) return "phone";
  if (platform !== "desktop") return "tablet";
  return viewportWidth < TABLET_MAX_WIDTH ? "tablet" : "desktop";
}

export const platform: Platform =
  typeof navigator === "undefined" ? "desktop" : detectPlatform(navigator.userAgent, navigator.maxTouchPoints);

export const isMobilePlatform = platform !== "desktop";

/** True inside the Tauri shell (as opposed to a plain browser with mock IPC). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window && !__SELIS_MOCK_IPC__;
}

type Insets = { top: number; right: number; bottom: number; left: number };

type AndroidBridge = {
  getInsets(): string;
  setDarkSystemBars(dark: boolean): void;
};

function androidBridge(): AndroidBridge | null {
  const bridge = (window as unknown as { SelisAndroid?: AndroidBridge }).SelisAndroid;
  return bridge ?? null;
}

function applyInsets(insets: Insets): void {
  const style = document.documentElement.style;
  style.setProperty("--native-inset-top", `${insets.top}px`);
  style.setProperty("--native-inset-right", `${insets.right}px`);
  style.setProperty("--native-inset-bottom", `${insets.bottom}px`);
  style.setProperty("--native-inset-left", `${insets.left}px`);
}

function parseInsets(value: unknown): Insets | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const nums = [v.top, v.right, v.bottom, v.left];
  if (!nums.every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0)) return null;
  return { top: v.top as number, right: v.right as number, bottom: v.bottom as number, left: v.left as number };
}

/** Mirrors Android edge-to-edge insets into CSS variables (see MainActivity.kt). */
export function installNativeInsets(): () => void {
  const bridge = androidBridge();
  if (!bridge) return () => undefined;
  try {
    const initial = parseInsets(JSON.parse(bridge.getInsets()));
    if (initial) applyInsets(initial);
  } catch {
    // Bridge present but returned garbage: env(safe-area-inset-*) still applies.
  }
  const onInsets = (event: Event) => {
    const insets = parseInsets((event as CustomEvent<unknown>).detail);
    if (insets) applyInsets(insets);
  };
  window.addEventListener("selis:insets", onInsets);
  return () => window.removeEventListener("selis:insets", onInsets);
}

/** Light/dark status- and navigation-bar icons to match the UI theme. */
export function setDarkSystemBars(dark: boolean): void {
  androidBridge()?.setDarkSystemBars(dark);
}
