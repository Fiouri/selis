/** Theme names understood by tokens.css (`<html data-theme=...>`). */
export const THEMES = ["light", "dark", "sepia"] as const;
export type ThemeName = (typeof THEMES)[number];

/** Mirrors the CSS motion tokens for JS-driven animation. */
export const MOTION_MS = { fast: 150, base: 200, slow: 250 } as const;

/** Minimum touch target (CSS px ≈ pt on mobile). */
export const TOUCH_TARGET_PX = 44;
