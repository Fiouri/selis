/**
 * Scan (P4c, ADR 0016; docs/design/p4-ui-brief.md §7): full screen over the library. The
 * camera with the live page outline → "Adjust corners" (handles, filters) → the queue of
 * scanned pages → "Save as PDF" (a new document, opened in the viewer). Back steps out of
 * Adjust and the queue; leaving with scanned pages asks first. "Scan a photo" takes a photo already
 * on the device through the same Adjust step (no camera, e.g. the iOS simulator).
 */
import { placement, type Quad, scaleQuad, smoothQuad, svgPoints, toBox } from "@selis/scan";
import { Button, IconButton } from "@selis/ui";
import { useQueryClient } from "@tanstack/react-query";
import { CameraOff, ImageUp, Images, Settings, X, Zap, ZapOff } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { FullScreenLayer } from "../../components/FullScreenLayer";
import { useToast } from "../../components/Toast";
import { api } from "../../lib/api";
import { type Camera, CameraError, type CameraFailure, openBackCamera } from "../../lib/camera";
import { assetUrl } from "../../lib/files";
import { platform } from "../../lib/platform";
import { useNavigation, useOverlay, whenHistorySettled } from "../../state/navigation";
import { nativePicker } from "../images/imagesStore";
import { documentsKey } from "../library/queries";
import { Busy } from "../transfer/parts";
import { AdjustCorners } from "./AdjustCorners";
import { type Frame, photoStill, sampleFrame, takeStill } from "./capture";
import { ScanQueue } from "./ScanQueue";
import { scanStats } from "./scanStats";
import { stillPixels, useScan } from "./scanStore";

/** Live detection rate cap: enough for a steady outline, light on the battery. */
const DETECT_INTERVAL_MS = 66;
/** The outline jumps (instead of easing) when a corner moves more than this share of the frame. */
const JUMP_SHARE = 0.08;
/** Frames without a page before the outline is hidden. */
const MISSES_TO_HIDE = 4;

type CameraStatus = "starting" | "live" | CameraFailure;

function today(locale: string): string {
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

/** True while the app is in the foreground (the camera is let go in the background). */
function useVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

/**
 * One photo already on the device for the scan's Adjust step: the system photo picker on
 * Android (single choice), a file input elsewhere (WKWebView shows PHPicker). The photo is
 * staged, read and unstaged at once; nothing else keeps it.
 */
function usePickScanPhoto(onPhoto: (blob: Blob) => void, onFailed: () => void): { pick: () => void; input: ReactNode } {
  const ref = useRef<HTMLInputElement>(null);
  const input = nativePicker ? null : (
    <input
      ref={ref}
      type="file"
      accept="image/*"
      hidden
      data-testid="scan-photo-input"
      onChange={(event) => {
        const file = event.target.files?.[0];
        // The same photo can be picked again.
        event.target.value = "";
        if (file) onPhoto(file);
      }}
    />
  );
  const pickNative = async () => {
    try {
      const picked = await api.pickPhotos(1);
      const source = picked.status === "picked" ? picked.sources[0] : undefined;
      if (!source) return;
      const path = await api.stagePhoto(source);
      try {
        onPhoto(await (await fetch(assetUrl(path))).blob());
      } finally {
        void api.unstage(path).catch(() => undefined);
      }
    } catch {
      onFailed();
    }
  };
  return {
    pick: () => {
      if (nativePicker) void pickNative();
      else ref.current?.click();
    },
    input,
  };
}

function CameraView({ onChoosePhotos, onClose }: { onChoosePhotos: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  const phase = useScan((s) => s.phase);
  const pages = useScan((s) => s.pages);
  const client = useScan((s) => s.client);
  const capture = useScan((s) => s.capture);
  const showQueue = useScan((s) => s.showQueue);
  const visible = useVisible();
  const video = useRef<HTMLVideoElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const camera = useRef<Camera | null>(null);
  const [status, setStatus] = useState<CameraStatus>("starting");
  const [torch, setTorch] = useState<{ available: boolean; on: boolean }>({ available: false, on: false });
  const [outline, setOutline] = useState<{ quad: Quad; frame: { width: number; height: number } } | null>(null);
  const [boxSize, setBoxSize] = useState({ width: 0, height: 0 });
  const [videoSize, setVideoSize] = useState({ width: 0, height: 0 });
  const [retry, setRetry] = useState(0);
  const capturing = phase.step === "capturing";
  const wanted = (phase.step === "camera" || capturing) && visible;

  // The camera runs only while this view is up and the app is in the foreground.
  useEffect(() => {
    const el = video.current;
    if (!wanted || !el) return;
    // An object, not a `let`: it changes in the cleanup, after the awaits below.
    const run = { cancelled: false };
    setStatus("starting");
    void (async () => {
      try {
        const opened = await openBackCamera(el, 1920, 1080);
        if (run.cancelled) {
          opened.stop();
          return;
        }
        camera.current = opened;
        setTorch({ available: opened.hasTorch, on: false });
        setStatus("live");
      } catch (err) {
        if (!run.cancelled) setStatus(err instanceof CameraError ? err.failure : "unavailable");
      }
    })();
    return () => {
      run.cancelled = true;
      camera.current?.stop();
      camera.current = null;
      setOutline(null);
    };
  }, [wanted, retry]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setBoxSize({ width: el.clientWidth, height: el.clientHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Live page detection: one frame at a time in the scan worker, at most ~15 a second.
  useEffect(() => {
    const el = video.current;
    if (status !== "live" || phase.step !== "camera" || !client || !el) return;
    const run = { stopped: false };
    // Read through a function: TypeScript keeps the loop condition's narrowing across awaits.
    const stopped = () => run.stopped;
    let misses = 0;
    let previous: Quad | null = null;
    const canvas = document.createElement("canvas");
    const stats = scanStats();
    stats.start();
    void (async () => {
      while (!stopped()) {
        const started = performance.now();
        const frame: Frame | null = sampleFrame(el, canvas);
        if (frame) {
          try {
            const { quad, ms } = await client.live(frame.rgba, frame.width, frame.height, started);
            stats.detected(ms, quad !== null);
            if (stopped()) break;
            if (quad) {
              misses = 0;
              previous = smoothQuad(previous, quad, Math.max(frame.width, frame.height) * JUMP_SHARE);
              setOutline({ quad: previous, frame: { width: frame.width, height: frame.height } });
            } else if (++misses >= MISSES_TO_HIDE) {
              previous = null;
              setOutline(null);
            }
          } catch {
            // A frame that could not be checked (the worker is still starting, or closing):
            // try the next one; a closed session stops the loop through `stopped`.
          }
        }
        const wait = DETECT_INTERVAL_MS - (performance.now() - started);
        await new Promise((resolve) => window.setTimeout(resolve, Math.max(0, wait)));
      }
    })();
    return () => {
      run.stopped = true;
      stats.stop();
      canvas.width = 0;
    };
  }, [status, phase.step, client]);

  const onShutter = async () => {
    const cam = camera.current;
    const el = video.current;
    if (!cam || !el || !client || phase.step !== "camera") return;
    const ok = await capture(() => takeStill(cam.track, el, stillPixels(), !client.canvasInWorker));
    if (!ok) useToast.getState().show(t("scan.captureFailed"), "error");
  };

  const scanPhoto = usePickScanPhoto(
    (blob) => {
      void (async () => {
        const ok = await capture(() => photoStill(blob, stillPixels(), !client?.canvasInWorker));
        if (!ok) useToast.getState().show(t("scan.photoFailed"), "error");
      })();
    },
    () => useToast.getState().show(t("scan.photoFailed"), "error"),
  );

  const onTorch = async () => {
    const cam = camera.current;
    if (!cam) return;
    const next = !torch.on;
    if (await cam.setTorch(next)) setTorch({ available: true, on: next });
  };

  const shown =
    outline && videoSize.width > 0 && boxSize.width > 0
      ? toBox(
          scaleQuad(outline.quad, videoSize.width / outline.frame.width, videoSize.height / outline.frame.height),
          placement(videoSize, boxSize, "cover"),
        )
      : null;
  const last = pages[pages.length - 1];
  const failed = status === "denied" || status === "unavailable";

  return (
    <div className="flex h-full flex-col bg-[#0c0c0f] text-[#f4f4f6]" data-testid="scan-camera" data-camera={status}>
      <header
        className="flex shrink-0 items-center gap-1 px-1"
        style={{ paddingTop: "var(--safe-top)", height: "calc(var(--safe-top) + 52px)" }}
      >
        <IconButton label={t("scan.close")} icon={<X size={22} strokeWidth={1.75} />} onClick={onClose} className="text-[#f4f4f6]! hover:bg-[#ffffff]/10! active:bg-[#ffffff]/20!" />
        <h1 className="min-w-0 flex-1 truncate text-[17px] font-semibold">{t("scan.title")}</h1>
        {scanPhoto.input}
        <IconButton
          label={t("scan.fromPhoto")}
          icon={<ImageUp size={22} strokeWidth={1.75} />}
          onClick={scanPhoto.pick}
          disabled={capturing || !client}
          className="text-[#f4f4f6]! hover:bg-[#ffffff]/10! active:bg-[#ffffff]/20!"
          data-testid="scan-from-photo"
        />
        <span className="px-3 text-sm tabular-nums text-[#c9c9d1]" data-testid="scan-count">
          {t("scan.count", { count: pages.length })}
        </span>
      </header>
      <div ref={box} className="relative min-h-0 flex-1 overflow-hidden">
        <video
          ref={video}
          className={`absolute inset-0 size-full object-cover ${status === "live" ? "" : "invisible"}`}
          aria-label={t("scan.viewfinder")}
          muted
          playsInline
          onLoadedMetadata={(e) => setVideoSize({ width: e.currentTarget.videoWidth, height: e.currentTarget.videoHeight })}
          onResize={(e) => setVideoSize({ width: e.currentTarget.videoWidth, height: e.currentTarget.videoHeight })}
          data-testid="scan-video"
        />
        {shown ? (
          <svg className="pointer-events-none absolute inset-0 size-full" aria-hidden="true" data-testid="scan-outline">
            <polygon points={svgPoints(shown)} fill="var(--accent-9)" fillOpacity={0.2} stroke="var(--accent-9)" strokeWidth={2} strokeLinejoin="round" />
          </svg>
        ) : null}
        {status === "live" && !shown && !capturing ? (
          <p className="absolute inset-x-0 bottom-4 mx-auto w-fit rounded-full bg-[#000000]/60 px-3 py-1 text-[13px]" data-testid="scan-hint">
            {t("scan.hint")}
          </p>
        ) : null}
        {capturing ? (
          <div className="absolute inset-0 flex items-center justify-center bg-[#000000]/50">
            <div className="rounded-[16px] bg-surface-raised px-6 py-3">
              <Busy label={t("scan.processing")} testId="scan-capturing" />
            </div>
          </div>
        ) : null}
        {failed ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-8 text-center" role="alert" data-testid="scan-camera-problem">
            <CameraOff size={40} strokeWidth={1.5} aria-hidden="true" />
            <p className="max-w-[300px] text-md">{status === "denied" ? t("scan.cameraDenied") : t("scan.cameraUnavailable")}</p>
            <div className="flex flex-col items-center gap-2">
              {status === "denied" && platform === "android" ? (
                <Button
                  icon={<Settings size={20} strokeWidth={1.75} />}
                  onClick={() => {
                    void api.openAppSettings().catch(() => undefined);
                  }}
                  data-testid="scan-open-settings"
                >
                  {t("scan.openSettings")}
                </Button>
              ) : null}
              {status === "denied" && platform !== "android" ? (
                <Button variant="secondary" onClick={() => setRetry((n) => n + 1)} data-testid="scan-retry">
                  {t("scan.tryAgain")}
                </Button>
              ) : null}
              <Button
                variant={status === "denied" && platform === "android" ? "secondary" : "primary"}
                icon={<ImageUp size={20} strokeWidth={1.75} />}
                onClick={scanPhoto.pick}
                disabled={!client}
                data-testid="scan-problem-photo"
              >
                {t("scan.fromPhoto")}
              </Button>
              <Button variant="ghost" className="text-[#f4f4f6]! hover:bg-[#ffffff]/10! active:bg-[#ffffff]/20!" icon={<Images size={20} strokeWidth={1.75} />} onClick={onChoosePhotos} data-testid="scan-choose-photos">
                {t("scan.choosePhotos")}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
      <footer className="flex shrink-0 items-center justify-between px-6" style={{ height: "calc(var(--safe-bottom) + 96px)", paddingBottom: "var(--safe-bottom)" }}>
        <div className="flex size-11 items-center justify-center">
          {last ? (
            <button
              type="button"
              className="selis-focus relative size-11 overflow-hidden rounded-[8px] border border-[#ffffff]/40"
              onClick={showQueue}
              data-testid="scan-queue-open"
            >
              <span className="sr-only">{t("scan.openQueue", { count: pages.length })}</span>
              <img src={last.thumb} alt="" className="size-full object-cover" />
              <span className="absolute -top-0 -right-0 min-w-5 rounded-bl-[6px] bg-accent-9 px-1 text-[12px] font-semibold text-accent-contrast tabular-nums" aria-hidden="true">
                {pages.length}
              </span>
            </button>
          ) : null}
        </div>
        <button
          type="button"
          className="selis-focus flex size-[72px] items-center justify-center rounded-full border-4 border-[#ffffff] disabled:opacity-40"
          onClick={() => void onShutter()}
          disabled={status !== "live" || capturing || !client}
          data-testid="scan-shutter"
        >
          {/* A visually hidden name, not aria-label: device tests find the button by its text. */}
          <span className="sr-only">{t("scan.shutter")}</span>
          <span className="size-[56px] rounded-full bg-[#ffffff]" aria-hidden="true" />
        </button>
        <div className="flex size-11 items-center justify-center">
          {torch.available ? (
            <IconButton
              label={torch.on ? t("scan.flashOff") : t("scan.flashOn")}
              icon={torch.on ? <Zap size={22} strokeWidth={1.75} /> : <ZapOff size={22} strokeWidth={1.75} />}
              onClick={() => void onTorch()}
              aria-pressed={torch.on}
              className="text-[#f4f4f6]! hover:bg-[#ffffff]/10! active:bg-[#ffffff]/20!"
              data-testid="scan-flash"
            />
          ) : null}
        </div>
      </footer>
    </div>
  );
}

export function ScanScreen({ onChoosePhotos }: { onChoosePhotos: () => void }) {
  const { t, i18n } = useTranslation();
  const phase = useScan((s) => s.phase);
  const pageCount = useScan((s) => s.pages.length);
  const close = useScan((s) => s.close);
  const retake = useScan((s) => s.retake);
  const backToCamera = useScan((s) => s.backToCamera);
  const save = useScan((s) => s.save);
  const openDocument = useNavigation((s) => s.openDocument);
  const showToast = useToast((s) => s.show);
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const open = phase.step !== "closed";

  const requestClose = () => {
    if (useScan.getState().phase.step === "saving") return;
    if (useScan.getState().pages.length > 0) setConfirming(true);
    else close();
  };
  // One history entry for the screen (released while the discard question is up), one each
  // for Adjust and the queue: system back steps out of them first.
  useOverlay(open && !confirming, requestClose);
  useOverlay(phase.step === "adjust", retake);
  useOverlay(phase.step === "queue", backToCamera);

  if (!open) return null;

  const onSave = async () => {
    const result = await save(t("scan.documentTitle", { date: today(i18n.language) }));
    if (result.kind === "created") {
      void queryClient.invalidateQueries({ queryKey: documentsKey });
      showToast(t("scan.saved"));
      await whenHistorySettled();
      openDocument(result.document.id);
    } else {
      showToast(t("scan.saveFailed"), "error");
    }
  };

  let body;
  if (phase.step === "adjust" || phase.step === "keeping") body = <AdjustCorners />;
  else if (phase.step === "queue" || phase.step === "saving") body = <ScanQueue onSave={() => void onSave()} />;
  else
    body = (
      <CameraView
        onClose={requestClose}
        onChoosePhotos={() => {
          close();
          onChoosePhotos();
        }}
      />
    );

  return (
    <FullScreenLayer label={t("scan.title")} className="bg-[#0c0c0f]" testId="scan-screen">
      {body}
      <ConfirmDialog
        open={confirming}
        title={t("scan.discardTitle", { count: pageCount })}
        message={t("scan.discardBody")}
        confirmLabel={t("scan.discard")}
        cancelLabel={t("scan.keepScanning")}
        danger
        onConfirm={() => {
          setConfirming(false);
          close();
        }}
        onCancel={() => setConfirming(false)}
        testId="scan-discard"
      />
    </FullScreenLayer>
  );
}
