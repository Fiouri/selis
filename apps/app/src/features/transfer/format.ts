/** Formatting for the Transfer screen. */

/** "14.2 MB" / "14,2 MB" (locale decimal), KB below a megabyte. */
export function formatBytes(bytes: number, locale: string): string {
  const mb = bytes >= 1024 * 1024;
  const value = mb ? bytes / (1024 * 1024) : Math.max(bytes / 1024, bytes > 0 ? 0.1 : 0);
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: mb ? "megabyte" : "kilobyte",
    unitDisplay: "short",
    maximumFractionDigits: 1,
  }).format(value);
}

/** "482913" → "482 913" (thin grouping helps reading it aloud). */
export function formatCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

/** 0–100, never NaN. */
export function percent(done: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.min(100, Math.max(0, Math.floor((done / total) * 100)));
}

/** Seconds left as "9:41". */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Trims a pasted link; anything that cannot be one is refused early (Rust validates it fully). */
export function cleanLink(input: string): string | null {
  const link = input.trim();
  if (link.length === 0 || link.length > 4096) return null;
  return link.startsWith("selis://transfer/") || /^selis[a-z0-9]+$/i.test(link) ? link : null;
}
