import { deflateSync } from "node:zlib";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { firstPageRendered, importFixture, SCREENSHOTS } from "./helpers";

type Inspect = { ids: () => string[]; versions: (id: string) => number; documentText: (id: string) => Promise<string> };
type TestWindow = { __selisTest: { inspect: Inspect } };

async function versions(page: Page): Promise<number> {
  return page.evaluate(() => {
    const api = (window as unknown as TestWindow).__selisTest.inspect;
    return api.versions(api.ids()[0] as string);
  });
}

async function documentText(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const api = (window as unknown as TestWindow).__selisTest.inspect;
    return api.documentText(api.ids()[0] as string);
  });
}

async function open(page: Page, file: string): Promise<void> {
  await page.goto("/");
  await importFixture(page, file);
  await expect(page.getByTestId("viewer-screen")).toBeVisible();
  await firstPageRendered(page);
}

async function at(target: Locator, fx: number, fy: number): Promise<{ x: number; y: number }> {
  const box = await target.boundingBox();
  if (!box) throw new Error("not laid out");
  return { x: box.x + box.width * fx, y: box.y + box.height * fy };
}

async function drag(page: Page, target: Locator, from: [number, number], to: [number, number], steps = 10): Promise<void> {
  const a = await at(target, ...from);
  const b = await at(target, ...to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps });
  await page.mouse.up();
}

/** A dark scribble on white paper, as a photo of a signature would be. */
function signaturePhoto(): Buffer {
  const width = 160;
  const height = 60;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ink = Math.abs(y - 30 - 18 * Math.sin(x / 14)) < 2.5;
      const o = y * (1 + width * 3) + 1 + x * 3;
      raw[o] = ink ? 25 : 246;
      raw[o + 1] = ink ? 30 : 244;
      raw[o + 2] = ink ? 90 : 236;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = (crcTable[(c ^ b) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("sign: draw, type and picture signatures; place, move, resize, undo; Done makes a version", async ({ page }, info) => {
  await open(page, "greek.pdf");
  await page.getByTestId("dock-sign").click();
  await expect(page.getByTestId("sign-sheet")).toBeVisible();
  await expect(page.getByTestId("sign-badge")).toHaveText("Visual signature");
  await expect(page.getByTestId("sign-hint")).toContainText("no saved signature");

  // Draw.
  await page.getByTestId("signature-new").click();
  await expect(page.getByTestId("new-signature-sheet")).toBeVisible();
  await expect(page.getByTestId("signature-save")).toBeDisabled();
  const pad = page.getByTestId("signature-pad");
  await expect(pad).toBeVisible();
  await page.waitForTimeout(300); // the sheet slides in: measure the pad once it has settled
  await drag(page, pad, [0.1, 0.6], [0.4, 0.3]);
  await drag(page, pad, [0.4, 0.3], [0.8, 0.65]);
  await page.screenshot({ path: `${SCREENSHOTS}/${info.project.name}-sign-draw.png` });
  await page.getByTestId("signature-save").click();
  await expect(page.getByTestId("new-signature-sheet")).toHaveCount(0);
  await expect(page.getByTestId("signature-card")).toHaveCount(1);
  await expect(page.getByTestId("signature-card")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("sign-hint")).toContainText("Tap the page");

  // Type (Greek name, handwriting font).
  await page.getByTestId("signature-new").click();
  await page.getByTestId("signature-mode-type").click();
  await page.getByTestId("signature-name").fill("Μαρία Παπαδοπούλου");
  await page.getByTestId("signature-font-mynerve").click();
  await expect(page.getByTestId("signature-font-mynerve")).toHaveAttribute("aria-checked", "true");
  await page.screenshot({ path: `${SCREENSHOTS}/${info.project.name}-sign-type.png` });
  await page.getByTestId("signature-save").click();
  await expect(page.getByTestId("signature-card")).toHaveCount(2);

  // Picture: paper removed, cropped.
  await page.getByTestId("signature-new").click();
  await page.getByTestId("signature-mode-image").click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("signature-pick").click();
  await (await chooser).setFiles({ name: "signature.png", mimeType: "image/png", buffer: signaturePhoto() });
  await expect(page.getByTestId("signature-picture-preview").locator("img")).toBeVisible();
  await expect(page.getByTestId("signature-remove-background")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("signature-save").click();
  await expect(page.getByTestId("signature-card")).toHaveCount(3);

  // Place the newest (selected) on page 1, then move and resize it.
  const layer = page.getByTestId("signature-layer-1");
  const spot = await at(layer, 0.5, 0.45);
  await page.mouse.click(spot.x, spot.y);
  await expect(page.getByTestId("signature-selection")).toBeVisible();
  await expect(page.getByTestId("annotate-undo")).toBeEnabled();
  const selection = page.getByTestId("signature-selection");
  const before = await selection.boundingBox();
  await drag(page, selection, [0.5, 0.5], [0.5, 1.8]);
  await expect.poll(async () => (await selection.boundingBox())?.y ?? 0).toBeGreaterThan((before?.y ?? 0) + 20);
  const corner = await at(selection, 1, 1);
  await page.mouse.move(corner.x + 4, corner.y + 4);
  await page.mouse.down();
  await page.mouse.move(corner.x + 60, corner.y + 30, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await selection.boundingBox())?.width ?? 0).toBeGreaterThan((before?.width ?? 0) + 30);
  await page.screenshot({ path: `${SCREENSHOTS}/${info.project.name}-sign-placed.png` });

  // Undo the resize, redo it.
  await page.getByTestId("annotate-undo").click();
  await expect(page.getByTestId("annotate-redo")).toBeEnabled();
  await page.getByTestId("annotate-redo").click();

  // Delete a saved signature (long press / right click on its card).
  await page.getByTestId("signature-card").last().click({ button: "right" });
  await expect(page.getByTestId("signature-delete-dialog")).toBeVisible();
  await page.getByTestId("signature-delete-dialog-confirm").click();
  await expect(page.getByTestId("signature-card")).toHaveCount(2);

  await page.getByTestId("annotate-done").click();
  await expect(page.getByTestId("sign-sheet")).toHaveCount(0);
  await expect.poll(() => versions(page)).toBe(2);
  const pdf = await documentText(page);
  expect(pdf).toContain("/Stamp");
  expect(pdf).toContain("selis-sig-");
});

test("forms: banner, fill text (Greek), checkbox, choice, next/previous, flatten with undo", async ({ page }, info) => {
  await open(page, "acroform.pdf");
  await expect(page.getByTestId("form-banner")).toContainText("Form with 4 fields");
  await page.getByTestId("form-fill").click();
  await expect(page.getByTestId("form-sheet")).toBeVisible();
  await expect(page.getByTestId("form-position")).toContainText("Tap a field");

  // Tap the first field, then "next" walks the form in order.
  await page.getByTestId("field-full_name").click();
  await expect(page.getByTestId("form-position")).toHaveText("Field 1 of 4");
  await page.getByTestId("field-input-full_name").fill("Γιάννης Παπαδόπουλος");
  await page.screenshot({ path: `${SCREENSHOTS}/${info.project.name}-form-text.png` });
  await page.getByTestId("form-next").click();
  await expect(page.getByTestId("form-position")).toHaveText("Field 2 of 4");
  await expect(page.getByTestId("field-input-email")).toBeFocused();
  await page.getByTestId("field-input-email").fill("maria@example.gr");
  await page.getByTestId("field-input-email").press("Enter");
  await expect(page.getByTestId("annotate-undo")).toBeEnabled();
  await page.getByTestId("form-next").click();
  await expect(page.getByTestId("form-position")).toHaveText("Field 3 of 4");
  await page.getByTestId("form-previous").click();
  await expect(page.getByTestId("form-position")).toHaveText("Field 2 of 4");

  const agree = page.getByTestId("field-agree");
  await expect(agree).toHaveAttribute("aria-checked", "true");
  await agree.click();
  await expect(agree).toHaveAttribute("aria-checked", "false");
  await page.getByTestId("annotate-undo").click();
  await expect(agree).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("annotate-redo").click();
  await expect(agree).toHaveAttribute("aria-checked", "false");

  await page.getByTestId("field-plan").selectOption({ label: "Archivist" });
  await expect(page.getByTestId("field-plan")).toHaveValue("2");

  await page.getByTestId("form-flatten").click();
  await expect(page.getByTestId("flatten-dialog")).toBeVisible();
  await page.getByTestId("flatten-dialog-confirm").click();
  await expect(page.getByTestId("form-position")).toHaveText("This document has no form fields.");
  await page.getByTestId("annotate-undo").click();
  await expect(page.getByTestId("field-plan")).toHaveValue("2");

  await page.getByTestId("annotate-done").click();
  await expect(page.getByTestId("form-sheet")).toHaveCount(0);
  await expect.poll(() => versions(page)).toBe(2);
  const pdf = await documentText(page);
  expect(pdf).toContain("/AcroForm");
  expect(pdf).toContain("Archivist");
});
