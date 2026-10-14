/**
 * The back camera in the WebView (ADR 0013): `getUserMedia`, no native plugin. On Android the
 * WebView asks for the camera permission (wry's WebChromeClient); iOS WKWebView asks itself.
 * Used by the transfer QR scanner and the document scan (P4c, ADR 0016).
 */

export type CameraFailure = "denied" | "unavailable";

export class CameraError extends Error {
  readonly failure: CameraFailure;

  constructor(failure: CameraFailure) {
    super(failure);
    this.name = "CameraError";
    this.failure = failure;
  }
}

function failureOf(err: unknown): CameraFailure {
  const name = err instanceof DOMException ? err.name : "";
  return name === "NotAllowedError" || name === "SecurityError" ? "denied" : "unavailable";
}

/** `torch` is in the Media Capture spec extensions, not yet in TypeScript's DOM types. */
type TorchCapabilities = MediaTrackCapabilities & { torch?: boolean };
type TorchConstraintSet = MediaTrackConstraintSet & { torch?: boolean };

export type Camera = {
  readonly track: MediaStreamTrack;
  /** The device has a torch the WebView can switch. */
  readonly hasTorch: boolean;
  setTorch: (on: boolean) => Promise<boolean>;
  stop: () => void;
};

/**
 * Starts the back camera into `video` at about `width × height` (the browser picks the
 * nearest mode). Rejects with a `CameraError`.
 */
export async function openBackCamera(video: HTMLVideoElement, width: number, height: number): Promise<Camera> {
  // Absent outside secure contexts and in some WebViews, whatever the types say.
  const media = navigator.mediaDevices as MediaDevices | undefined;
  if (typeof media?.getUserMedia !== "function") throw new CameraError("unavailable");
  let stream: MediaStream;
  try {
    stream = await media.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: width }, height: { ideal: height } },
      audio: false,
    });
  } catch (err) {
    throw new CameraError(failureOf(err));
  }
  const track = stream.getVideoTracks()[0];
  if (!track) {
    for (const t of stream.getTracks()) t.stop();
    throw new CameraError("unavailable");
  }
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  try {
    await video.play();
  } catch {
    // Autoplay of a muted inline stream is allowed; frames still arrive.
  }
  const capabilities = (typeof track.getCapabilities === "function" ? track.getCapabilities() : {}) as TorchCapabilities;
  let stopped = false;
  return {
    track,
    hasTorch: capabilities.torch === true,
    setTorch: async (on) => {
      try {
        await track.applyConstraints({ advanced: [{ torch: on } as TorchConstraintSet] });
        return true;
      } catch {
        return false;
      }
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      for (const t of stream.getTracks()) t.stop();
      if (video.srcObject === stream) video.srcObject = null;
    },
  };
}
