/**
 * Scanned-page fixtures for OCR (P4d): A4 pages that are only images — text rendered at
 * 300 dpi with Noto Sans by @napi-rs/canvas, slightly skewed, on a faint paper tone with sensor
 * noise, stored as JPEG — and no text layer. `SCANNED_TEXT` holds the words each page
 * shows, for the accuracy checks (pdf.js must find ≥ 95 % of them after OCR).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { n, PdfWriter, type Ref, Str } from "./pdf-writer.ts";
import { woffToSfnt } from "./font.ts";

const require = createRequire(import.meta.url);

/** Lines per page; a line starting with "# " is a heading. */
export const SCANNED_TEXT = {
  greek: [
    [
      "# Σάρωση εγγράφων στη συσκευή",
      "Η Σελίς διαβάζει το κείμενο μιας σαρωμένης σελίδας χωρίς να",
      "στείλει τίποτα έξω από το κινητό σου. Η αναγνώριση γίνεται",
      "τοπικά και το αποτέλεσμα αποθηκεύεται ως νέα έκδοση.",
      "Μετά την αναγνώριση μπορείς να αναζητήσεις λέξεις όπως",
      "«συμβόλαιο», «απόδειξη» ή «ημερομηνία» και να αντιγράψεις",
      "προτάσεις από την εικόνα της σελίδας.",
      "# Παράδειγμα επιστολής",
      "Αγαπητέ κύριε Παπαδόπουλε, σας ευχαριστούμε για την άμεση",
      "απάντηση. Η συνάντηση ορίστηκε για την Τετάρτη στις δέκα",
      "το πρωί, στο γραφείο της οδού Ερμού στην Αθήνα.",
      "Παρακαλούμε να φέρετε μαζί σας την ταυτότητα και το",
      "υπογεγραμμένο έντυπο της αίτησης.",
      "Με εκτίμηση, η γραμματεία.",
    ],
    [
      "# Δεύτερη σελίδα",
      "Οι τόνοι και τα διαλυτικά πρέπει να αναγνωρίζονται σωστά:",
      "άλλος, έλεγχος, ήλιος, ίδιος, όμορφος, ύπνος, ώρα,",
      "προϊόν, ευφυΐα, Ευρωπαϊκή ένωση, θεϊκός.",
      "Ο κατάλογος περιλαμβάνει τρία είδη: χαρτί, μελάνι και",
      "φακέλους. Η παράδοση θα γίνει μέσα σε πέντε εργάσιμες",
      "ημέρες από την παραγγελία.",
      "Για οποιαδήποτε απορία επικοινωνήστε με το τμήμα",
      "εξυπηρέτησης πελατών.",
    ],
  ],
  english: [
    [
      "# Scanning documents on the device",
      "Selis reads the text of a scanned page without sending",
      "anything off your phone. Recognition runs locally and the",
      "result is saved as a new version of the document.",
      "After recognition you can search for words such as",
      "contract, receipt or deadline and copy sentences from",
      "the picture of the page.",
      "# Example letter",
      "Dear Ms Thompson, thank you for your prompt reply. The",
      "meeting has been arranged for Wednesday at ten in the",
      "morning, at our office on Baker Street in London.",
      "Please bring your passport and the signed application",
      "form with you. Kind regards, the secretary.",
    ],
    [
      "# Second page",
      "The catalogue lists three items: paper, ink and envelopes.",
      "Delivery takes five working days from the order date.",
      "Invoice number 2026-1042, total amount 318.50 euros.",
      "For any question please contact customer service.",
    ],
  ],
} as const;

export type ScannedLanguage = keyof typeof SCANNED_TEXT;

/** The words a page shows (headings included), without punctuation. */
export function scannedWords(language: ScannedLanguage, page: number): string[] {
  const lines = SCANNED_TEXT[language][page] ?? [];
  return lines.flatMap((line) => line.replace(/^# /, "").split(/\s+/)).map((w) => w.replace(/^[«(]+|[».,:;)]+$/g, "")).filter((w) => w !== "");
}

const DPI = 300;
const A4_PX: [number, number] = [2480, 3508];
const A4_PT: [number, number] = [595.28, 841.89];

let fontsReady = false;
function registerFonts(): void {
  if (fontsReady) return;
  for (const subset of ["latin", "greek"]) {
    const path = require.resolve(`@fontsource/noto-sans/files/noto-sans-${subset}-400-normal.woff`);
    GlobalFonts.register(Buffer.from(woffToSfnt(new Uint8Array(readFileSync(path)))), `SelisScan-${subset}`);
  }
  fontsReady = true;
}

/** A deterministic pseudo-random sequence (xorshift). */
function noise(seed: number): () => number {
  let s = seed | 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1000) / 1000;
  };
}

/** One page as a greyscale JPEG at 300 dpi. */
function scanPage(lines: readonly string[], seed: number, skewDeg: number): Uint8Array {
  registerFonts();
  const [w, h] = A4_PX;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#f4f2ec";
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate((skewDeg * Math.PI) / 180);
  ctx.translate(-w / 2, -h / 2);
  ctx.fillStyle = "#1b1b1b";
  ctx.textBaseline = "alphabetic";
  let y = 300;
  for (const line of lines) {
    const heading = line.startsWith("# ");
    // 11 pt body (46 px at 300 dpi), 16 pt headings.
    ctx.font = `${heading ? "67px" : "46px"} SelisScan-latin, SelisScan-greek`;
    if (heading && y > 300) y += 40;
    ctx.fillText(heading ? line.slice(2) : line, 236, y);
    y += heading ? 110 : 76;
  }
  ctx.restore();
  // Sensor noise and a slight vignette, as a phone or flatbed leaves them.
  const image = ctx.getImageData(0, 0, w, h);
  const rand = noise(seed);
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    const px = (i / 4) % w;
    const py = Math.floor(i / 4 / w);
    const dx = px / w - 0.5;
    const dy = py / h - 0.5;
    const shade = 1 - 0.08 * (dx * dx + dy * dy) * 4;
    const v = Math.max(0, Math.min(255, (d[i] ?? 0) * shade + (rand() - 0.5) * 18));
    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v;
  }
  ctx.putImageData(image, 0, 0);
  // The canvas encoder writes RGB JPEG (of grey pixels), as a phone scan app would.
  return new Uint8Array(canvas.encodeSync("jpeg", 72));
}

function pageImage(w: PdfWriter, jpeg: Uint8Array): Ref {
  return w.addStream(
    {
      Type: n("XObject"),
      Subtype: n("Image"),
      Width: A4_PX[0],
      Height: A4_PX[1],
      ColorSpace: n("DeviceRGB"),
      BitsPerComponent: 8,
      Filter: n("DCTDecode"),
    },
    jpeg,
    false,
  );
}

/** An image-only PDF of the `language` pages (no text layer). */
export function buildScanned(language: ScannedLanguage): Uint8Array {
  const w = new PdfWriter(`selis-fixture-scanned-${language}`);
  const pagesRef = w.reserve();
  const kids = SCANNED_TEXT[language].map((lines, i) => {
    const image = pageImage(w, scanPage(lines, 17 + i * 31 + (language === "greek" ? 0 : 7), i % 2 === 0 ? 0.35 : -0.25));
    const [pw, ph] = A4_PT;
    const contents = w.addStream({}, `q ${String(pw)} 0 0 ${String(ph)} 0 0 cm /Im0 Do Q`);
    return w.add({
      Type: n("Page"),
      Parent: pagesRef,
      MediaBox: [0, 0, pw, ph],
      Resources: { XObject: { Im0: image } },
      Contents: contents,
    });
  });
  w.set(pagesRef, { Type: n("Pages"), Kids: kids, Count: kids.length });
  w.setRoot(w.add({ Type: n("Catalog"), Pages: pagesRef }));
  w.setInfo({ Title: Str.utf16(language === "greek" ? "Σαρωμένο έγγραφο" : "Scanned document") });
  return w.toBytes();
}

export const SCANNED_DPI = DPI;
