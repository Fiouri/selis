/**
 * Realistic sample documents for store screenshots and the website (P5a): a lease, a trip
 * itinerary, an invoice and a quarterly report, in English and in Greek. Every name, address
 * and number is invented; nothing comes from real people or third-party documents. Text in
 * embedded Noto Sans (Latin + Greek, regular + bold) with ToUnicode maps, so search, selection
 * and OCR-free reading work as with any real PDF.
 *
 * Not part of the test corpus (FIXTURES): `npm run samples -w @selis/fixtures` writes them to
 * packages/fixtures/out/samples/<lang>/.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { A4, EmbeddedFont, finishDocument } from "./corpus.ts";
import { parseTrueType, woffToSfnt } from "./font.ts";
import { PdfWriter, Str } from "./pdf-writer.ts";

export type SampleLanguage = "en" | "el";

export type Sample = {
  readonly file: string;
  readonly title: string;
  /** The first line of the first page. */
  readonly heading: string;
  readonly pageCount: number;
  build(): Uint8Array;
};

const require = createRequire(import.meta.url);

type FontKey = "R" | "B" | "GR" | "GB";

function load(script: "latin" | "greek", weight: 400 | 700, name: string): EmbeddedFont {
  const path = require.resolve(`@fontsource/noto-sans/files/noto-sans-${script}-${String(weight)}-normal.woff`);
  return new EmbeddedFont(parseTrueType(woffToSfnt(new Uint8Array(readFileSync(path)))), name);
}

/** A page being laid out top-down, in points from the top-left (converted to PDF space). */
class Page {
  readonly ops: string[] = [];
  y = 72;
  private readonly fonts: Record<FontKey, EmbeddedFont>;
  constructor(fonts: Record<FontKey, EmbeddedFont>) {
    this.fonts = fonts;
  }

  private runs(text: string, bold: boolean): Array<{ key: FontKey; text: string }> {
    const runs: Array<{ key: FontKey; text: string }> = [];
    for (const ch of text) {
      const cp = ch.codePointAt(0) as number;
      const latin: FontKey = bold ? "B" : "R";
      const greek: FontKey = bold ? "GB" : "GR";
      const key = this.fonts[latin].has(cp) ? latin : this.fonts[greek].has(cp) ? greek : null;
      if (!key) throw new Error(`no glyph for U+${cp.toString(16)} in "${text}"`);
      const last = runs.at(-1);
      if (last?.key === key) last.text += ch;
      else runs.push({ key, text: ch });
    }
    return runs;
  }

  width(text: string, size: number, bold = false): number {
    let w = 0;
    for (const run of this.runs(text, bold)) {
      const font = this.fonts[run.key].font;
      for (const ch of run.text) w += font.advance(font.glyphId(ch.codePointAt(0) as number));
    }
    return (w * size) / 1000;
  }

  text(text: string, x: number, y: number, size: number, options: { bold?: boolean; color?: string } = {}): void {
    const bold = options.bold ?? false;
    const shown = this.runs(text, bold).map((r) => ` /${r.key} ${String(size)} Tf ${this.fonts[r.key].encode(r.text)} Tj`);
    this.ops.push(`BT ${options.color ?? "0.13 0.12 0.10"} rg ${x.toFixed(2)} ${(A4[1] - y).toFixed(2)} Td${shown.join("")} ET`);
  }

  /** Word-wrapped paragraph at the cursor; returns nothing, moves the cursor. */
  para(text: string, size = 10.5, options: { bold?: boolean; x?: number; width?: number; gap?: number } = {}): void {
    const x = options.x ?? 64;
    const max = options.width ?? A4[0] - x - 64;
    const lead = size * 1.45;
    let line = "";
    for (const word of text.split(" ")) {
      const next = line ? `${line} ${word}` : word;
      if (this.width(next, size, options.bold) > max && line) {
        this.y += lead;
        this.text(line, x, this.y, size, options);
        line = word;
      } else line = next;
    }
    if (line) {
      this.y += lead;
      this.text(line, x, this.y, size, options);
    }
    this.y += options.gap ?? 8;
  }

  heading(text: string, size = 13): void {
    this.y += 10;
    this.para(text, size, { bold: true, gap: 4 });
  }

  rect(x: number, y: number, w: number, h: number, fill: string): void {
    this.ops.push(`${fill} rg ${x.toFixed(2)} ${(A4[1] - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
  }

  line(x1: number, y1: number, x2: number, y2: number, gray = 0.75, width = 0.8): void {
    this.ops.push(`${String(gray)} G ${String(width)} w ${x1.toFixed(2)} ${(A4[1] - y1).toFixed(2)} m ${x2.toFixed(2)} ${(A4[1] - y2).toFixed(2)} l S`);
  }
}

type Builder = (page: () => Page) => void;

function document(title: string, lang: SampleLanguage, build: Builder): Uint8Array {
  const fonts: Record<FontKey, EmbeddedFont> = {
    R: load("latin", 400, "AAAAAA+NotoSans-Regular"),
    B: load("latin", 700, "AAAAAB+NotoSans-Bold"),
    GR: load("greek", 400, "AAAAAC+NotoSans-Greek"),
    GB: load("greek", 700, "AAAAAD+NotoSans-GreekBold"),
  };
  const pages: Page[] = [];
  build(() => {
    const p = new Page(fonts);
    pages.push(p);
    return p;
  });
  const w = new PdfWriter(`selis-sample-${title}`);
  // Content first, fonts after: the used-glyph sets must be complete when the fonts are written.
  const contents = pages.map((p) => p.ops.join("\n"));
  const resources = { Font: { R: fonts.R.write(w), B: fonts.B.write(w), GR: fonts.GR.write(w), GB: fonts.GB.write(w) } };
  finishDocument(
    w,
    contents.map((content) => ({ size: A4, content })),
    resources,
    { Lang: Str.ascii(lang === "el" ? "el-GR" : "en-GB") },
  );
  w.setInfo({ Title: Str.utf16(title), Author: Str.ascii("Selis sample") });
  return w.toBytes();
}

type Strings = {
  lease: { file: string; title: string; heading: string; parties: string; clauses: Array<[string, string]>; sign: [string, string] };
  trip: { file: string; title: string; subtitle: string; days: Array<[string, string]> };
  invoice: { file: string; title: string; from: string; address: string; to: string; columns: [string, string, string, string]; rows: Array<[string, number, number]>; subtotal: string; vat: string; total: string; note: string };
  report: { file: string; title: string; summary: string; chart: string; quarters: [string, string, string, string]; outlook: string; outlookText: string };
};

const TEXT: Record<SampleLanguage, Strings> = {
  en: {
    lease: {
      file: "Lease agreement.pdf",
      title: "Lease agreement",
      heading: "Residential lease agreement",
      parties:
        "This agreement is made on 1 October 2026 between Helen Carter (the landlord) and Daniel Reyes (the tenant) for the flat at 14 Harbour Lane, Flat 3, Brightwater.",
      clauses: [
        ["1. Term", "The lease runs for twelve months, from 1 November 2026 to 31 October 2027, and renews for another year unless either party gives two months' notice in writing."],
        ["2. Rent", "The monthly rent is €850, paid by bank transfer on the first working day of each month. Utilities other than water are paid by the tenant."],
        ["3. Deposit", "The tenant pays a deposit of two months' rent, returned within thirty days of the end of the lease, less the cost of any damage beyond normal wear."],
        ["4. Use of the property", "The flat is used as a private home only. Pets are allowed with the landlord's written consent. Subletting is not allowed."],
        ["5. Repairs", "The landlord keeps the structure, heating and plumbing in good repair; the tenant reports faults promptly and keeps the flat clean and ventilated."],
        ["6. Ending the lease", "Either party may end the lease after the first six months with two months' notice. The keys are returned on the last day."],
      ],
      sign: ["Landlord", "Tenant"],
    },
    trip: {
      file: "Trip to Crete.pdf",
      title: "Trip to Crete",
      subtitle: "Five days in western Crete · 12–16 May 2027",
      days: [
        ["Day 1 — Chania", "Arrive at Chania airport at 10:40. Check in at the guesthouse in the old town. Afternoon walk along the Venetian harbour and dinner by the lighthouse."],
        ["Day 2 — Balos lagoon", "Boat from Kissamos at 10:00. Swim in the lagoon, lunch on board, back at 17:30. Bring water, sunscreen and cash for the park fee."],
        ["Day 3 — Samaria gorge", "Early bus at 06:15 to Omalos. 16 km downhill walk, about six hours. Ferry from Agia Roumeli to Sfakia, bus back to Chania."],
        ["Day 4 — Rethymno", "Morning drive to Rethymno. The Fortezza, the old town and the Rimondi fountain. Cooking class at 18:00."],
        ["Day 5 — Elafonissi", "Pink-sand beach and the cedar reserve. Return the car at the airport by 19:00; flight at 21:05."],
      ],
    },
    invoice: {
      file: "Invoice 2026-014.pdf",
      title: "Invoice 2026-014",
      from: "Ariadne Design",
      address: "12 Olive Road · 70013 Heraklion · hello@example.com",
      to: "Billed to: Northwind Studio, 8 Mill Street, Lakeport · Date: 30 September 2026 · Due: 30 October 2026",
      columns: ["Description", "Qty", "Unit price", "Amount"],
      rows: [
        ["Website design — homepage and five pages", 1, 2400],
        ["Illustrations for the product pages", 6, 180],
        ["Copywriting, English and Greek", 12, 45],
        ["Hosting set-up and handover", 1, 300],
      ],
      subtotal: "Subtotal",
      vat: "VAT 24%",
      total: "Total",
      note: "Payment by bank transfer to IBAN GR00 0000 0000 0000 0000 0000 000 (sample). Thank you!",
    },
    report: {
      file: "Quarterly report Q3.pdf",
      title: "Quarterly report Q3 2026",
      summary:
        "Orders grew for the third quarter in a row, driven by the new online shop and repeat customers. Costs stayed flat thanks to the move to a shared warehouse.",
      chart: "Orders per quarter (thousands)",
      quarters: ["Q4 2025", "Q1 2026", "Q2 2026", "Q3 2026"],
      outlook: "Outlook",
      outlookText:
        "For the fourth quarter we expect the usual holiday peak. We will hire two seasonal staff, extend the delivery hours in December and test same-day delivery in the city centre.",
    },
  },
  el: {
    lease: {
      file: "Μισθωτήριο.pdf",
      title: "Μισθωτήριο κατοικίας",
      heading: "Ιδιωτικό συμφωνητικό μίσθωσης κατοικίας",
      parties:
        "Σήμερα, 1 Οκτωβρίου 2026, η Ελένη Καραγιάννη (εκμισθώτρια) και ο Δημήτρης Ρήγας (μισθωτής) συμφωνούν τη μίσθωση του διαμερίσματος στην οδό Λιμανιού 14, 3ος όροφος, Ακρογιαλιά.",
      clauses: [
        ["1. Διάρκεια", "Η μίσθωση διαρκεί δώδεκα μήνες, από 1 Νοεμβρίου 2026 έως 31 Οκτωβρίου 2027, και ανανεώνεται για έναν ακόμη χρόνο, εκτός αν κάποιο μέρος ειδοποιήσει γραπτώς δύο μήνες νωρίτερα."],
        ["2. Μίσθωμα", "Το μηνιαίο μίσθωμα είναι 850 €, με τραπεζική μεταφορά την πρώτη εργάσιμη κάθε μήνα. Τους λογαριασμούς πλην του νερού πληρώνει ο μισθωτής."],
        ["3. Εγγύηση", "Ο μισθωτής καταβάλλει εγγύηση δύο μισθωμάτων, που επιστρέφεται μέσα σε τριάντα ημέρες από τη λήξη, μείον το κόστος τυχόν φθορών πέρα από τη συνήθη χρήση."],
        ["4. Χρήση", "Το διαμέρισμα χρησιμοποιείται μόνο ως κατοικία. Κατοικίδια επιτρέπονται με γραπτή συναίνεση της εκμισθώτριας. Υπεκμίσθωση δεν επιτρέπεται."],
        ["5. Επισκευές", "Η εκμισθώτρια φροντίζει τον φέροντα οργανισμό, τη θέρμανση και τις υδραυλικές εγκαταστάσεις· ο μισθωτής αναφέρει έγκαιρα τις βλάβες και διατηρεί το σπίτι καθαρό."],
        ["6. Λύση", "Μετά τους πρώτους έξι μήνες κάθε μέρος μπορεί να λύσει τη μίσθωση με προειδοποίηση δύο μηνών. Τα κλειδιά παραδίδονται την τελευταία ημέρα."],
      ],
      sign: ["Η εκμισθώτρια", "Ο μισθωτής"],
    },
    trip: {
      file: "Ταξίδι στην Κρήτη.pdf",
      title: "Ταξίδι στην Κρήτη",
      subtitle: "Πέντε μέρες στη δυτική Κρήτη · 12–16 Μαΐου 2027",
      days: [
        ["1η μέρα — Χανιά", "Άφιξη στο αεροδρόμιο Χανίων στις 10:40. Τακτοποίηση στον ξενώνα της παλιάς πόλης. Απογευματινή βόλτα στο ενετικό λιμάνι και δείπνο κοντά στον φάρο."],
        ["2η μέρα — Μπάλος", "Καραβάκι από την Κίσσαμο στις 10:00. Μπάνιο στη λιμνοθάλασσα, φαγητό στο σκάφος, επιστροφή στις 17:30. Νερό, αντηλιακό και μετρητά για την είσοδο."],
        ["3η μέρα — Φαράγγι της Σαμαριάς", "Λεωφορείο στις 06:15 για τον Ομαλό. Κατάβαση 16 χλμ., περίπου έξι ώρες. Πλοίο από την Αγία Ρουμέλη στα Σφακιά και λεωφορείο για Χανιά."],
        ["4η μέρα — Ρέθυμνο", "Πρωινή διαδρομή για Ρέθυμνο. Φορτέτσα, παλιά πόλη και κρήνη Ριμόντι. Μάθημα μαγειρικής στις 18:00."],
        ["5η μέρα — Ελαφονήσι", "Η παραλία με τη ροζ άμμο και ο κεδρώνας. Επιστροφή του αυτοκινήτου στο αεροδρόμιο ως τις 19:00· πτήση στις 21:05."],
      ],
    },
    invoice: {
      file: "Τιμολόγιο 2026-014.pdf",
      title: "Τιμολόγιο 2026-014",
      from: "Αριάδνη Design",
      address: "Οδός Ελιάς 12 · 70013 Ηράκλειο · hello@example.com",
      to: "Προς: Βορειάς Στούντιο, Μύλου 8, Λιμνούπολη · Ημερομηνία: 30 Σεπτεμβρίου 2026 · Λήξη: 30 Οκτωβρίου 2026",
      columns: ["Περιγραφή", "Ποσ.", "Τιμή μονάδας", "Ποσό"],
      rows: [
        ["Σχεδιασμός ιστότοπου — αρχική και πέντε σελίδες", 1, 2400],
        ["Εικονογράφηση για τις σελίδες προϊόντων", 6, 180],
        ["Κείμενα, ελληνικά και αγγλικά", 12, 45],
        ["Ρύθμιση φιλοξενίας και παράδοση", 1, 300],
      ],
      subtotal: "Μερικό σύνολο",
      vat: "ΦΠΑ 24%",
      total: "Σύνολο",
      note: "Πληρωμή με τραπεζική μεταφορά στο IBAN GR00 0000 0000 0000 0000 0000 000 (δείγμα). Ευχαριστούμε!",
    },
    report: {
      file: "Έκθεση Γ΄ τριμήνου.pdf",
      title: "Έκθεση Γ΄ τριμήνου 2026",
      summary:
        "Οι παραγγελίες αυξήθηκαν για τρίτο συνεχόμενο τρίμηνο, χάρη στο νέο ηλεκτρονικό κατάστημα και στους σταθερούς πελάτες. Το κόστος έμεινε σταθερό μετά τη μετάβαση σε κοινή αποθήκη.",
      chart: "Παραγγελίες ανά τρίμηνο (χιλιάδες)",
      quarters: ["Δ΄ 2025", "Α΄ 2026", "Β΄ 2026", "Γ΄ 2026"],
      outlook: "Προοπτικές",
      outlookText:
        "Για το τέταρτο τρίμηνο περιμένουμε τη συνηθισμένη αιχμή των γιορτών. Θα προσλάβουμε δύο εποχικούς υπαλλήλους, θα επεκτείνουμε τις ώρες παράδοσης τον Δεκέμβριο και θα δοκιμάσουμε παράδοση αυθημερόν στο κέντρο.",
    },
  },
};

const ACCENT = "0.141 0.263 0.561";
const MUTED = "0.42 0.40 0.36";

function money(value: number, lang: SampleLanguage): string {
  return new Intl.NumberFormat(lang === "el" ? "el-GR" : "en-GB", { style: "currency", currency: "EUR" }).format(value);
}

function lease(s: Strings["lease"], lang: SampleLanguage): Uint8Array {
  return document(s.title, lang, (newPage) => {
    const p = newPage();
    p.rect(0, 0, A4[0], 8, ACCENT);
    p.para(s.heading, 18, { bold: true, gap: 14 });
    p.para(s.parties, 10.5, { gap: 10 });
    for (const [title, body] of s.clauses) {
      p.heading(title, 11.5);
      p.para(body);
    }
    p.y += 64;
    const [left, right] = s.sign;
    p.line(64, p.y, 250, p.y);
    p.line(345, p.y, 531, p.y);
    p.text(left, 64, p.y + 16, 10, { color: MUTED });
    p.text(right, 345, p.y + 16, 10, { color: MUTED });
  });
}

function trip(s: Strings["trip"], lang: SampleLanguage): Uint8Array {
  return document(s.title, lang, (newPage) => {
    const p = newPage();
    p.rect(0, 0, A4[0], 120, "0.89 0.92 0.97");
    p.y = 48;
    p.para(s.title, 26, { bold: true, gap: 2 });
    p.para(s.subtitle, 12, { gap: 30 });
    for (const [day, body] of s.days) {
      p.heading(day, 13);
      p.para(body, 10.5, { gap: 10 });
    }
  });
}

function invoice(s: Strings["invoice"], lang: SampleLanguage): Uint8Array {
  return document(s.title, lang, (newPage) => {
    const p = newPage();
    p.para(s.from, 20, { bold: true, gap: 0 });
    p.para(s.address, 9.5, { gap: 24 });
    p.para(s.title, 16, { bold: true, gap: 4 });
    p.para(s.to, 9.5, { gap: 20 });
    const cols = [64, 350, 410, 480];
    p.rect(56, p.y, A4[0] - 112, 26, "0.93 0.92 0.90");
    s.columns.forEach((c, i) => {
      p.text(c, cols[i] ?? 64, p.y + 17, 10, { bold: true });
    });
    p.y += 26;
    let subtotal = 0;
    for (const [description, qty, unit] of s.rows) {
      const amount = qty * unit;
      subtotal += amount;
      p.text(description, cols[0] ?? 64, p.y + 20, 10);
      p.text(String(qty), cols[1] ?? 0, p.y + 20, 10);
      p.text(money(unit, lang), cols[2] ?? 0, p.y + 20, 10);
      p.text(money(amount, lang), cols[3] ?? 0, p.y + 20, 10);
      p.y += 30;
      p.line(56, p.y, A4[0] - 56, p.y, 0.85, 0.6);
    }
    const vat = Math.round(subtotal * 0.24);
    for (const [label, value, bold] of [
      [s.subtotal, subtotal, false],
      [s.vat, vat, false],
      [s.total, subtotal + vat, true],
    ] as const) {
      p.y += 24;
      p.text(label, 350, p.y, 11, { bold });
      p.text(money(value, lang), 480, p.y, 11, { bold });
    }
    p.y += 48;
    p.para(s.note, 9.5, { gap: 0 });
  });
}

function report(s: Strings["report"], lang: SampleLanguage): Uint8Array {
  return document(s.title, lang, (newPage) => {
    const p = newPage();
    p.para(s.title, 22, { bold: true, gap: 16 });
    p.para(s.summary, 11, { gap: 24 });
    p.para(s.chart, 11, { bold: true, gap: 12 });
    const values = [38, 44, 51, 63];
    const base = p.y + 220;
    p.line(64, base, 531, base, 0.6, 1);
    values.forEach((v, i) => {
      const h = v * 3;
      const x = 96 + i * 110;
      p.rect(x, base - h, 64, h, i === values.length - 1 ? ACCENT : "0.62 0.70 0.89");
      p.text(String(v), x + 22, base - h - 8, 10, { bold: true });
      p.text(s.quarters[i] ?? "", x + 2, base + 18, 9.5, { color: MUTED });
    });
    p.y = base + 50;
    p.heading(s.outlook, 13);
    p.para(s.outlookText, 11);
  });
}

export function samples(lang: SampleLanguage): Sample[] {
  const s = TEXT[lang];
  return [
    { file: s.lease.file, title: s.lease.title, heading: s.lease.heading, pageCount: 1, build: () => lease(s.lease, lang) },
    { file: s.trip.file, title: s.trip.title, heading: s.trip.title, pageCount: 1, build: () => trip(s.trip, lang) },
    { file: s.invoice.file, title: s.invoice.title, heading: s.invoice.from, pageCount: 1, build: () => invoice(s.invoice, lang) },
    { file: s.report.file, title: s.report.title, heading: s.report.title, pageCount: 1, build: () => report(s.report, lang) },
  ];
}
