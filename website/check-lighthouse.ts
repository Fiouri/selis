/**
 * Fails unless every Lighthouse report scores at least MIN in performance, accessibility,
 * best practices and SEO (website quality gate, ADR 0024).
 * Usage: node website/check-lighthouse.ts <report.json>...
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const MIN = 0.95;
const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"] as const;

type Report = { finalDisplayedUrl?: string; categories: Record<string, { score: number | null } | undefined>; audits: Record<string, { score: number | null; title: string } | undefined> };

let failed = false;
for (const file of process.argv.slice(2)) {
  const report = JSON.parse(readFileSync(file, "utf8")) as Report;
  const scores = CATEGORIES.map((c) => [c, report.categories[c]?.score ?? 0] as const);
  const low = scores.filter(([, s]) => s < MIN);
  console.log(`${report.finalDisplayedUrl ?? basename(file)}: ${scores.map(([c, s]) => `${c} ${String(Math.round(s * 100))}`).join(", ")}`);
  if (low.length > 0) {
    failed = true;
    const audits = Object.values(report.audits).filter((a) => a && a.score !== null && a.score < 0.9);
    for (const a of audits.slice(0, 12)) console.log(`  - ${a?.title ?? ""} (${String(a?.score)})`);
  }
}
if (failed) {
  console.error(`Lighthouse: a category is below ${String(MIN * 100)}`);
  process.exit(1);
}
