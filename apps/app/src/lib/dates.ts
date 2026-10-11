/** Short, locale-aware dates for library metadata ("Σήμερα", "Χθες", "3 Οκτ"). */

const DAY_MS = 86_400_000;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function capitalize(text: string, locale: string): string {
  const first = text.charAt(0);
  return first ? first.toLocaleUpperCase(locale) + text.slice(1) : text;
}

/** Today / yesterday / weekday within a week / day + month (+ year if not this year). */
export function relativeDay(timestamp: number, now: number, locale: string): string {
  const days = Math.round((startOfDay(now) - startOfDay(timestamp)) / DAY_MS);
  if (days >= 0 && days <= 1) {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    return capitalize(rtf.format(-days, "day"), locale);
  }
  if (days > 1 && days < 7) {
    return capitalize(new Intl.DateTimeFormat(locale, { weekday: "long" }).format(timestamp), locale);
  }
  const sameYear = new Date(timestamp).getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(locale, sameYear ? { day: "numeric", month: "short" } : { dateStyle: "medium" }).format(
    timestamp,
  );
}
