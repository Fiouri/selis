/**
 * Transfer in the mock backend (Playwright, `vite --mode mock`): a scripted
 * other device. Progress follows the clock (1.5 s for a transfer), and tests
 * drive the other side through `window.__selisTest.transfer`:
 *
 * - `peerScans()`: a receiver scanned the offered code (both show the code);
 * - `senderConfirms()`: the sending device confirmed (a receive starts);
 * - `hold(true)`: transfers stop at 40 % (screenshots), `hold(false)` resumes;
 * - `incoming(files)`: what the next receive brings (default: a 1-page PDF);
 * - `failReceive(code)`: the next receive fails with that error after the code;
 * - `link(url)`: a `selis://` deep link arrives (camera app, another app);
 * - `expireOffers()`: offered codes expire now.
 */
import qrSvg from "@selis/fixtures/transfer/qr.svg?raw";
import fixtureLink from "@selis/fixtures/transfer/link.txt?raw";
import type {
  CommandError,
  ImportOutcome,
  OfferView,
  ReceiveView,
  ResumableView,
  SendView,
  TransferErrorCode,
  TransferInfo,
} from "./ipc";

/** The code both screens show in the mock. */
export const MOCK_CODE = "482913";
const TRANSFER_MS = 1_500;
const CONNECT_MS = 300;
const HOLD_FRACTION = 0.4;

type Send = {
  offer: OfferView;
  scanned: boolean;
  decided: null | boolean;
  startedAt: number;
  cancelled: boolean;
};

type Receive = {
  id: string;
  link: string;
  createdAt: number;
  confirmedAt: number | null;
  /** Bytes already there when it (re)started. */
  baseBytes: number;
  total: number;
  fail: TransferErrorCode | null;
  files: Array<{ name: string; bytes: Uint8Array }>;
  result: ReceiveView | null;
  importing: boolean;
};

type Hooks = {
  peerScans: () => void;
  senderConfirms: () => void;
  hold: (on: boolean) => void;
  incoming: (files: Array<{ name: string; bytes: number[] }>) => void;
  failReceive: (code: TransferErrorCode | null) => void;
  link: (url: string) => void;
  expireOffers: () => void;
};

type Deps = {
  fail: (code: CommandError["code"], message: string) => never;
  runOnce: <T>(command: string, requestId: string, work: () => Promise<T>) => Promise<T>;
  documentSizes: (ids: string[]) => number[];
  importBytes: (name: string, bytes: Uint8Array) => Promise<ImportOutcome>;
  localOnly: () => boolean;
};

/** A minimal one-page PDF (valid xref) for receives nobody scripted. */
export function tinyPdf(label: string): Uint8Array {
  const text = label.replace(/[()\\]/g, "");
  const content = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.7\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** Runs `work` now; its result or error as a promise (what `runOnce` stores). */
function settle<T>(work: () => T): Promise<T> {
  try {
    return Promise.resolve(work());
  } catch (err) {
    // `fail` throws the serialized CommandError, like Tauri rejects (see mock-ipc.ts).
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    return Promise.reject(err);
  }
}

export function createMockTransfer(deps: Deps) {
  let open = false;
  let held = false;
  let nextFail: TransferErrorCode | null = null;
  let nextFiles: Array<{ name: string; bytes: Uint8Array }> | null = null;
  let pendingLink: string | null = null;
  const sends = new Map<string, Send>();
  const receives = new Map<string, Receive>();
  const links = new Map<string, string>();

  const progress = (since: number, total: number, base = 0) => {
    const fraction = Math.min(1, (Date.now() - since) / TRANSFER_MS);
    const limited = held ? Math.min(fraction, HOLD_FRACTION) : fraction;
    return Math.min(total, base + Math.floor((total - base) * limited));
  };

  const sendView = (s: Send): SendView => {
    if (s.cancelled) return { kind: "failed", error: "cancelled" };
    if (s.decided === false) return { kind: "failed", error: "declined" };
    if (s.decided === true) {
      const bytes = progress(s.startedAt, s.offer.totalBytes);
      return bytes >= s.offer.totalBytes ? { kind: "done" } : { kind: "sending", bytes, total: s.offer.totalBytes, route: "lan" };
    }
    if (Date.now() / 1000 >= s.offer.expiresAt) return { kind: "failed", error: "expired" };
    return s.scanned ? { kind: "confirm", code: MOCK_CODE } : { kind: "waitingForReceiver" };
  };

  const finishReceive = async (r: Receive) => {
    r.importing = true;
    const ids: string[] = [];
    let duplicates = 0;
    for (const file of r.files) {
      const outcome = await deps.importBytes(file.name, file.bytes);
      ids.push(outcome.document.id);
      if (outcome.duplicate) duplicates += 1;
    }
    r.result = { kind: "done", documentIds: ids, duplicates };
  };

  const receiveView = (r: Receive): ReceiveView => {
    if (r.result) return r.result;
    if (Date.now() - r.createdAt < CONNECT_MS) return { kind: "connecting" };
    if (r.confirmedAt === null) return { kind: "confirm", code: MOCK_CODE };
    if (r.fail) {
      const bytes = progress(r.confirmedAt, r.total, r.baseBytes);
      r.result =
        r.fail === "interrupted"
          ? { kind: "paused", bytes: Math.max(bytes, Math.floor(r.total / 3)), total: r.total }
          : { kind: "failed", error: r.fail };
      return r.result;
    }
    const bytes = progress(r.confirmedAt, r.total, r.baseBytes);
    if (bytes < r.total) return { kind: "receiving", bytes, total: r.total, route: "lan" };
    if (!r.importing) void finishReceive(r);
    return { kind: "saving" };
  };

  const resumable = (): ResumableView[] =>
    [...receives.values()]
      .filter((r) => r.result?.kind === "paused")
      .map((r) => ({
        id: r.id,
        docCount: r.files.length,
        totalBytes: r.total,
        doneBytes: r.result?.kind === "paused" ? r.result.bytes : 0,
        updatedAt: r.createdAt,
      }));

  const running = () =>
    [...sends.values()].some((s) => ["confirm", "sending"].includes(sendView(s).kind)) ||
    [...receives.values()].some((r) => ["connecting", "confirm", "receiving", "saving"].includes(receiveView(r).kind));

  const requireOpen = () => {
    if (!open) deps.fail("invalidArgument", "the transfer screen is not open");
  };

  const hooks: Hooks = {
    peerScans: () => {
      for (const s of sends.values()) if (!s.cancelled && s.decided === null) s.scanned = true;
    },
    senderConfirms: () => {
      for (const r of receives.values()) if (r.confirmedAt === null) r.confirmedAt = Date.now();
    },
    hold: (on) => {
      held = on;
    },
    incoming: (files) => {
      nextFiles = files.map((f) => ({ name: f.name, bytes: new Uint8Array(f.bytes) }));
    },
    failReceive: (code) => {
      nextFail = code;
    },
    link: (url) => {
      pendingLink = url;
      document.dispatchEvent(new Event("visibilitychange"));
    },
    expireOffers: () => {
      for (const s of sends.values()) s.offer = { ...s.offer, expiresAt: Date.now() / 1000 - 1 };
    },
  };

  const handle = async (cmd: string, args: Record<string, unknown>): Promise<unknown> => {
    switch (cmd) {
      case "transfer_open": {
        open = true;
        const info: TransferInfo = {
          deviceId: "mock-device",
          network: deps.localOnly() ? "localOnly" : "default",
          debug: false,
        };
        return info;
      }
      case "transfer_close": {
        if (!args.force && running()) return false;
        open = false;
        for (const s of sends.values()) if (s.decided === null) s.cancelled = true;
        return true;
      }
      case "transfer_offer":
        return deps.runOnce(cmd, String(args.requestId), () => settle(() => {
          requireOpen();
          const ids = args.documentIds as string[];
          if (ids.length === 0) deps.fail("invalidArgument", "choose documents to send");
          const total = deps.documentSizes(ids).reduce((a, b) => a + b, 0);
          const sessionId = crypto.randomUUID();
          const offer: OfferView = {
            sessionId,
            link: fixtureLink.trim(),
            qrSvg,
            docCount: ids.length,
            totalBytes: total,
            expiresAt: Math.floor(Date.now() / 1000) + 600,
          };
          sends.set(sessionId, { offer, scanned: false, decided: null, startedAt: 0, cancelled: false });
          return offer;
        }));
      case "transfer_send_status": {
        const s = sends.get(String(args.sessionId)) ?? deps.fail("notFound", "no such transfer");
        return sendView(s);
      }
      case "transfer_decide": {
        const s = sends.get(String(args.sessionId)) ?? deps.fail("notFound", "no such transfer");
        if (sendView(s).kind !== "confirm") deps.fail("invalidArgument", "nothing to confirm");
        s.decided = Boolean(args.confirm);
        s.startedAt = Date.now();
        return null;
      }
      case "transfer_cancel_send": {
        const s = sends.get(String(args.sessionId));
        if (s) s.cancelled = true;
        return null;
      }
      case "transfer_receive":
        return deps.runOnce(cmd, String(args.requestId), () => settle(() => {
          requireOpen();
          const link = String(args.link).trim();
          if (!link.startsWith("selis://transfer/selis")) deps.fail("invalidArgument", "invalidLink");
          const known = links.get(link);
          if (known) return known;
          const files = nextFiles ?? [{ name: "Received.pdf", bytes: tinyPdf("Received over Selis") }];
          nextFiles = null;
          const id = crypto.randomUUID();
          receives.set(id, {
            id,
            link,
            createdAt: Date.now(),
            confirmedAt: null,
            baseBytes: 0,
            total: files.reduce((sum, f) => sum + f.bytes.byteLength, 0),
            fail: nextFail,
            files,
            result: null,
            importing: false,
          });
          nextFail = null;
          links.set(link, id);
          return id;
        }));
      case "transfer_receive_status": {
        const r = receives.get(String(args.id)) ?? deps.fail("notFound", "no such transfer");
        return receiveView(r);
      }
      case "transfer_cancel_receive": {
        const r = receives.get(String(args.id));
        if (r) r.result = { kind: "failed", error: "cancelled" };
        return null;
      }
      case "transfer_resumable":
        return resumable();
      case "transfer_resume": {
        requireOpen();
        const r = receives.get(String(args.id)) ?? deps.fail("notFound", "no such transfer");
        if (r.result?.kind !== "paused") deps.fail("invalidArgument", "not resumable");
        r.baseBytes = r.result.bytes;
        r.result = null;
        r.fail = null;
        r.confirmedAt = Date.now();
        r.createdAt = Date.now() - CONNECT_MS;
        return null;
      }
      case "transfer_pause": {
        for (const r of receives.values()) {
          const view = receiveView(r);
          if (view.kind === "receiving") r.result = { kind: "paused", bytes: view.bytes, total: view.total };
        }
        return null;
      }
      case "transfer_foreground":
      case "transfer_foreground_stop":
      case "transfer_debug_force_relay":
        return null;
      case "transfer_notifications":
        return true;
      case "pending_transfer_link":
        return pendingLink;
      case "dismiss_transfer_link":
        if (pendingLink === args.link) pendingLink = null;
        return null;
      default:
        return deps.fail("invalidArgument", `unknown command ${cmd}`);
    }
  };

  return { handle, hooks };
}

export const TRANSFER_COMMANDS = new Set([
  "transfer_open",
  "transfer_close",
  "transfer_offer",
  "transfer_send_status",
  "transfer_decide",
  "transfer_cancel_send",
  "transfer_receive",
  "transfer_receive_status",
  "transfer_cancel_receive",
  "transfer_resumable",
  "transfer_resume",
  "transfer_pause",
  "transfer_foreground",
  "transfer_foreground_stop",
  "transfer_notifications",
  "transfer_debug_force_relay",
  "pending_transfer_link",
  "dismiss_transfer_link",
]);
