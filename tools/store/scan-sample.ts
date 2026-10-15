/**
 * A phone photo of a printed page on a desk, for the store screenshots of Scan's Adjust step
 * (the iOS simulator has no camera; Android uses the same photo through "Scan a photo"):
 * docs/store/scan-sample/<lang>.jpg, 1500 × 2000 JPEG.
 *
 * Rendered by Chromium from HTML (no image editor, reproducible): an invented delivery note in
 * Inter, tilted with a CSS perspective on a dark wooden desk (SVG turbulence), soft shadow and
 * light falloff, so the scan module has a real outline to find. Invented content only.
 *
 * Usage: node tools/store/scan-sample.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const ROOT = join(import.meta.dirname, "..", "..");
const OUT = join(ROOT, "docs", "store", "scan-sample");

type Note = {
  readonly title: string;
  readonly number: string;
  readonly from: string;
  readonly to: string;
  readonly head: readonly [string, string, string];
  readonly rows: readonly (readonly [string, string, string])[];
  readonly note: string;
  readonly signed: string;
  readonly delivered: string;
};

const NOTES: Record<"en" | "el", Note> = {
  en: {
    title: "Delivery note",
    number: "No. 2026-0412 · 14 October 2026",
    from: "Harbour Print Ltd · 22 Quay Street, Brightwater",
    to: "Deliver to: Ariadne Design, 12 Olive Road, Lakeport",
    head: ["Item", "Qty", "Note"],
    rows: [
      ["Business cards, matt 350 g", "500", "2 boxes"],
      ["Letterhead A4, 100 g", "1,000", "2 reams"],
      ["Envelopes DL, window", "500", "1 box"],
      ["Posters A2, gloss", "20", "rolled"],
      ["Brochures A5, folded", "250", "1 box"],
    ],
    note: "Checked on delivery. Report any damage within 7 days.",
    signed: "Received by",
    delivered: "Delivered by",
  },
  el: {
    title: "Δελτίο αποστολής",
    number: "Αρ. 2026-0412 · 14 Οκτωβρίου 2026",
    from: "Τυπογραφείο Λιμάνι · Οδός Αποβάθρας 22, Φωτεινή",
    to: "Παράδοση: Αριάδνη Σχεδιασμός, Οδός Ελιάς 12, Λιμνούπολη",
    head: ["Είδος", "Ποσ.", "Σημείωση"],
    rows: [
      ["Επαγγελματικές κάρτες, ματ 350 g", "500", "2 κουτιά"],
      ["Επιστολόχαρτο A4, 100 g", "1.000", "2 δεσμίδες"],
      ["Φάκελοι DL με παράθυρο", "500", "1 κουτί"],
      ["Αφίσες A2, γυαλιστερές", "20", "σε ρολό"],
      ["Φυλλάδια A5, διπλωμένα", "250", "1 κουτί"],
    ],
    note: "Ελέγχθηκε κατά την παράδοση. Ζημιές δηλώνονται εντός 7 ημερών.",
    signed: "Παρέλαβε",
    delivered: "Παρέδωσε",
  },
};

function fontFace(file: string): string {
  const data = readFileSync(join(ROOT, "node_modules", "@fontsource-variable", "inter", "files", file)).toString("base64");
  return `@font-face{font-family:Inter;font-weight:100 900;src:url(data:font/woff2;base64,${data}) format("woff2")}`;
}

function html(n: Note, fonts: string): string {
  const rows = n.rows.map(([a, b, c]) => `<tr><td>${a}</td><td class="r">${b}</td><td>${c}</td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>${fonts}
  html,body{margin:0;width:1500px;height:2000px;overflow:hidden;background:#3b2a1d}
  .desk{position:absolute;inset:0;background:linear-gradient(115deg,#5a3f2a,#3d2a1b 45%,#4e3623 70%,#2f2016)}
  .grain{position:absolute;inset:0;opacity:.35;mix-blend-mode:multiply}
  .light{position:absolute;inset:0;background:radial-gradient(ellipse at 45% 35%,rgba(255,236,200,.28),rgba(0,0,0,.45) 75%)}
  .stage{position:absolute;inset:0;perspective:2400px}
  .paper{position:absolute;left:250px;top:260px;width:1000px;height:1414px;background:#fbfaf6;
    transform:rotateX(14deg) rotateY(-5deg) rotateZ(-4deg);transform-origin:50% 60%;
    box-shadow:0 30px 60px rgba(0,0,0,.55),0 6px 14px rgba(0,0,0,.35);font-family:Inter;color:#23211d;
    padding:90px 84px;box-sizing:border-box}
  .paper::after{content:"";position:absolute;inset:0;background:linear-gradient(160deg,rgba(255,255,255,.0),rgba(0,0,0,.07))}
  h1{font-size:54px;margin:0 0 8px;font-weight:700;letter-spacing:-.5px}
  .no{font-size:26px;color:#5f574c;margin-bottom:46px}
  .addr{font-size:25px;line-height:1.5;margin-bottom:40px}
  table{width:100%;border-collapse:collapse;font-size:25px}
  th{text-align:left;border-bottom:3px solid #23211d;padding:12px 6px;font-weight:600}
  td{border-bottom:1.5px solid #c9c0b2;padding:15px 6px}.r{text-align:right;padding-right:28px}
  .note{font-size:23px;color:#5f574c;margin-top:40px;line-height:1.5}
  .sign{position:absolute;left:84px;right:84px;bottom:120px;display:flex;justify-content:space-between;font-size:23px;color:#5f574c}
  .sign span{border-top:2px solid #8a8071;padding-top:10px;width:330px}
  .ink{position:absolute;left:120px;bottom:150px;font:italic 600 52px Inter;color:#24438f;transform:rotate(-6deg)}
  </style></head><body><div class="desk"></div>
  <svg class="grain" width="1500" height="2000"><filter id="f"><feTurbulence type="fractalNoise" baseFrequency="0.004 0.09" numOctaves="4" seed="7"/></filter><rect width="1500" height="2000" filter="url(#f)"/></svg>
  <div class="stage"><div class="paper"><h1>${n.title}</h1><div class="no">${n.number}</div>
  <div class="addr">${n.from}<br>${n.to}</div>
  <table><tr><th>${n.head[0]}</th><th class="r">${n.head[1]}</th><th>${n.head[2]}</th></tr>${rows}</table>
  <div class="note">${n.note}</div><div class="ink">M. K.</div>
  <div class="sign"><span>${n.signed}</span><span>${n.delivered}</span></div></div></div>
  <div class="light"></div></body></html>`;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const fonts = fontFace("inter-latin-wght-normal.woff2") + fontFace("inter-greek-wght-normal.woff2");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 2000 } });
    for (const lang of ["en", "el"] as const) {
      await page.setContent(html(NOTES[lang], fonts));
      await page.evaluate("document.fonts.ready");
      const jpeg = await page.screenshot({ type: "jpeg", quality: 88 });
      writeFileSync(join(OUT, `${lang}.jpg`), jpeg);
      console.log(`${join(OUT, `${lang}.jpg`)} ${String(jpeg.length)} bytes`);
    }
  } finally {
    await browser.close();
  }
}

await main();
