/**
 * "Νέα υπογραφή": draw, type (three handwriting fonts with Greek) or pick a
 * picture. Every way ends in a transparent PNG kept on this device (Rust,
 * `signatures/`). Same system as the rest of the app: bottom sheet, segmented
 * control (brief §5), 44 px targets.
 */
import { Button, Segmented, Switch } from "@selis/ui";
import { useQueryClient } from "@tanstack/react-query";
import { ImagePlus } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sheet } from "../../components/Sheet";
import { useToast } from "../../components/Toast";
import type { Signature, SignatureKind } from "../../lib/api";
import { fontFamily, loadSignatureFont, type Point, pictureToPng, SIGNATURE_FONTS, type SignatureFontId, strokesToPng, typedToPng } from "./render";
import { createSignature, type PictureFile, pickPicture } from "./signatures";

type Mode = "draw" | "type" | "image";

/** Ink colours: signatures are on paper, the same in every theme. */
const INKS = { black: "#14181f", blue: "#1f3a8a" } as const;
type Ink = keyof typeof INKS;
const PAD_HEIGHT = 180;
const PEN_WIDTH = 2.6;

function InkPicker({ value, onChange }: { value: Ink; onChange: (ink: Ink) => void }) {
  const { t } = useTranslation();
  const labelId = useId();
  return (
    <div className="flex items-center gap-1">
      <span id={labelId} className="mr-2 text-sm text-neutral-11">
        {t("sign.ink")}
      </span>
      <div role="radiogroup" aria-labelledby={labelId} className="flex">
        {(Object.keys(INKS) as Ink[]).map((ink) => (
          <button
            key={ink}
            type="button"
            role="radio"
            aria-checked={ink === value}
            aria-label={t(ink === "black" ? "sign.inkBlack" : "sign.inkBlue")}
            onClick={() => onChange(ink)}
            className="selis-focus flex size-11 items-center justify-center rounded-full"
            data-testid={`ink-${ink}`}
          >
            <span
              className="block size-7 rounded-full"
              style={{
                background: INKS[ink],
                boxShadow: ink === value ? "0 0 0 2px var(--surface-raised), 0 0 0 4px var(--neutral-12)" : "none",
              }}
            />
          </button>
        ))}
      </div>
    </div>
  );
}

/** Paper-white pad with a baseline; one finger or a stylus draws. */
function DrawPad({ strokes, onStrokes, ink }: { strokes: Point[][]; onStrokes: (s: Point[][]) => void; ink: Ink }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState<Point[] | null>(null);

  const at = (e: { clientX: number; clientY: number }): Point => {
    const rect = ref.current?.getBoundingClientRect();
    return rect ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : { x: 0, y: 0 };
  };
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setCurrent([at(e)]);
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!current) return;
    const native = e.nativeEvent as unknown as { getCoalescedEvents?: () => PointerEvent[] };
    const samples = native.getCoalescedEvents?.() ?? [];
    const added = (samples.length > 0 ? samples : [e]).map(at);
    setCurrent((stroke) => (stroke ? [...stroke, ...added] : stroke));
  };
  const up = () => {
    if (current && current.length > 0) onStrokes([...strokes, current]);
    setCurrent(null);
  };
  const path = (pts: readonly Point[]) => pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const all = current ? [...strokes, current] : strokes;

  return (
    <div
      ref={ref}
      role="img"
      aria-label={t("sign.padLabel")}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      className="relative w-full touch-none overflow-hidden rounded-card border border-neutral-5 bg-paper"
      style={{ height: PAD_HEIGHT }}
      data-testid="signature-pad"
    >
      {/* Baseline with an "×", as on a paper form. */}
      <span className="pointer-events-none absolute inset-x-6 bottom-12 border-b border-paper-rule" aria-hidden="true" />
      <span className="pointer-events-none absolute bottom-[52px] left-6 text-lg text-paper-hint" aria-hidden="true">
        ×
      </span>
      {all.length === 0 ? (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-md text-paper-hint" aria-hidden="true">
          {t("sign.padHint")}
        </span>
      ) : null}
      <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
        {all.map((s, i) => (
          <path key={i} d={path(s)} fill="none" stroke={INKS[ink]} strokeWidth={PEN_WIDTH} strokeLinecap="round" strokeLinejoin="round" />
        ))}
      </svg>
    </div>
  );
}

function TypePanel({
  name,
  onName,
  font,
  onFont,
  ink,
}: {
  name: string;
  onName: (v: string) => void;
  font: SignatureFontId;
  onFont: (f: SignatureFontId) => void;
  ink: Ink;
}) {
  const { t } = useTranslation();
  const inputId = useId();
  const groupId = useId();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const request = { live: true };
    void (async () => {
      await Promise.all(SIGNATURE_FONTS.map((f) => loadSignatureFont(f.id).catch(() => undefined)));
      if (request.live) setReady(true);
    })();
    return () => {
      request.live = false;
    };
  }, []);
  const sample = name.trim() || t("sign.namePlaceholder").replace(/^.*?\s/, "");
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label htmlFor={inputId} className="text-sm font-medium text-neutral-12">
          {t("sign.nameLabel")}
        </label>
        <input
          id={inputId}
          value={name}
          onChange={(e) => onName(e.target.value)}
          placeholder={t("sign.namePlaceholder")}
          autoComplete="name"
          maxLength={80}
          className="selis-focus h-11 rounded-[12px] border border-neutral-6 bg-surface-app px-4 text-md text-neutral-12 placeholder:text-neutral-9"
          data-testid="signature-name"
        />
      </div>
      <span id={groupId} className="text-sm font-medium text-neutral-12">
        {t("sign.fonts")}
      </span>
      <div role="radiogroup" aria-labelledby={groupId} className="flex flex-col gap-2">
        {SIGNATURE_FONTS.map((f, i) => {
          const checked = f.id === font;
          return (
            <button
              key={f.id}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={t("sign.fontOption", { index: i + 1 })}
              onClick={() => onFont(f.id)}
              className={`selis-focus flex h-16 items-center overflow-hidden rounded-card border bg-paper px-4 text-left ${
                checked ? "border-transparent shadow-[inset_0_0_0_2px_var(--accent-9)]" : "border-neutral-5"
              }`}
              data-testid={`signature-font-${f.id}`}
            >
              <span
                className="truncate text-[30px] leading-none transition-opacity duration-150"
                style={{ fontFamily: `"${fontFamily(f.id)}", cursive`, color: INKS[ink], opacity: ready ? 1 : 0 }}
                aria-hidden="true"
              >
                {sample}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PicturePanel({
  picture,
  preview,
  removeBackground,
  onRemoveBackground,
  onPick,
}: {
  picture: PictureFile | null;
  preview: string | null;
  removeBackground: boolean;
  onRemoveBackground: (v: boolean) => void;
  onPick: () => void;
}) {
  const { t } = useTranslation();
  const switchLabel = useId();
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-neutral-11">{t("sign.imageHint")}</p>
      <div
        className="flex items-center justify-center overflow-hidden rounded-card border border-neutral-5 bg-paper"
        style={{
          height: PAD_HEIGHT,
          // Checkerboard: shows what the background removal made transparent.
          backgroundImage: "repeating-conic-gradient(var(--paper-checker) 0% 25%, var(--paper) 0% 50%)",
          backgroundSize: "16px 16px",
        }}
        data-testid="signature-picture-preview"
      >
        {preview ? (
          <img src={preview} alt="" className="max-h-full max-w-full object-contain p-3" />
        ) : (
          <Button variant="secondary" onClick={onPick} data-testid="signature-pick">
            <ImagePlus size={20} strokeWidth={1.75} aria-hidden="true" />
            {t("sign.pickImage")}
          </Button>
        )}
      </div>
      {picture ? (
        <div className="flex items-center justify-between">
          <span id={switchLabel} className="text-sm text-neutral-12">
            {t("sign.removeBackground")}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onPick}>
              {t("sign.pickAnother")}
            </Button>
            <Switch checked={removeBackground} onChange={onRemoveBackground} labelledBy={switchLabel} testId="signature-remove-background" />
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function NewSignatureSheet({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (s: Signature) => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const showToast = useToast((s) => s.show);
  const [mode, setMode] = useState<Mode>("draw");
  const [ink, setInk] = useState<Ink>("black");
  const [strokes, setStrokes] = useState<Point[][]>([]);
  const [name, setName] = useState("");
  const [font, setFont] = useState<SignatureFontId>("mansalva");
  const [picture, setPicture] = useState<PictureFile | null>(null);
  const [removeBackground, setRemoveBackground] = useState(true);
  const [preview, setPreview] = useState<{ url: string; png: Blob } | null>(null);
  const [saving, setSaving] = useState(false);

  // Processed picture preview (background removal and crop), redone when the toggle changes.
  useEffect(() => {
    if (!picture) return;
    const request: { live: boolean; url: string | null } = { live: true, url: null };
    void (async () => {
      try {
        const png = await pictureToPng(picture.bytes, picture.mime, removeBackground);
        if (!request.live) return;
        request.url = URL.createObjectURL(png);
        setPreview({ url: request.url, png });
      } catch (err) {
        console.warn("selis: picture could not be processed", err);
        if (request.live) showToast(t("sign.imageFailed"), "error");
      }
    })();
    return () => {
      request.live = false;
      if (request.url) URL.revokeObjectURL(request.url);
    };
  }, [picture, removeBackground, showToast, t]);

  const reset = () => {
    setStrokes([]);
    setName("");
    setPicture(null);
    setPreview(null);
    setSaving(false);
  };
  const close = () => {
    reset();
    onClose();
  };

  const pick = async () => {
    try {
      const picked = await pickPicture();
      if (picked) setPicture(picked);
    } catch (err) {
      console.warn("selis: picture picker failed", err);
      showToast(t("sign.imageFailed"), "error");
    }
  };

  const canSave = !saving && (mode === "draw" ? strokes.length > 0 : mode === "type" ? name.trim() !== "" : preview !== null);

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      let png: Blob;
      let kind: SignatureKind;
      if (mode === "draw") {
        png = await strokesToPng(strokes, INKS[ink], PEN_WIDTH);
        kind = "drawn";
      } else if (mode === "type") {
        png = await typedToPng(name, font, INKS[ink]);
        kind = "typed";
      } else {
        if (!preview) return;
        png = preview.png;
        kind = "image";
      }
      const saved = await createSignature(queryClient, kind, png);
      reset();
      onCreated(saved);
    } catch (err) {
      console.warn("selis: signature not saved", err);
      showToast(t("sign.saveFailed"), "error");
      setSaving(false);
    }
  };

  const panelId = "new-signature";
  return (
    <Sheet open={open} onClose={close} title={t("sign.newTitle")} testId="new-signature-sheet">
      <div className="flex flex-col gap-4 px-5 pb-2">
        <Segmented
          options={[
            { value: "draw", label: t("sign.modeDraw") },
            { value: "type", label: t("sign.modeType") },
            { value: "image", label: t("sign.modeImage") },
          ]}
          value={mode}
          onChange={setMode}
          label={t("sign.modes")}
          idPrefix={panelId}
          testId="signature-mode"
        />
        <div role="tabpanel" id={`${panelId}-panel-${mode}`} aria-labelledby={`${panelId}-tab-${mode}`} className="flex flex-col gap-3">
          {mode === "draw" ? (
            <>
              <DrawPad strokes={strokes} onStrokes={setStrokes} ink={ink} />
              <div className="flex items-center justify-between">
                <InkPicker value={ink} onChange={setInk} />
                <Button variant="ghost" onClick={() => setStrokes([])} disabled={strokes.length === 0} data-testid="signature-clear">
                  {t("sign.clear")}
                </Button>
              </div>
            </>
          ) : mode === "type" ? (
            <>
              <TypePanel name={name} onName={setName} font={font} onFont={setFont} ink={ink} />
              <InkPicker value={ink} onChange={setInk} />
            </>
          ) : (
            <PicturePanel
              picture={picture}
              preview={preview?.url ?? null}
              removeBackground={removeBackground}
              onRemoveBackground={setRemoveBackground}
              onPick={() => void pick()}
            />
          )}
        </div>
        <p className="text-xs text-neutral-11">{t("sign.localOnly")}</p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            {t("sign.cancel")}
          </Button>
          <Button onClick={() => void save()} disabled={!canSave} data-testid="signature-save">
            {t("sign.save")}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
