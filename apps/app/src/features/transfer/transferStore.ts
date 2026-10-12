/**
 * State of the Transfer screen (commands/transfer.rs, ADR 0010).
 *
 * The screen opens the endpoint when it mounts and asks to close it when it
 * unmounts or the app goes to the background; Rust keeps it open while a
 * transfer runs. The store outlives the screen so a transfer started here
 * keeps its progress (and its notification) when the user looks elsewhere.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";
import {
  ApiError,
  api,
  type OfferView,
  type ReceiveView,
  type ResumableView,
  type SendView,
  type TransferErrorCode,
  type TransferInfo,
} from "../../lib/api";
import { i18n } from "../../i18n";
import { cleanLink, percent } from "./format";

export type TransferTab = "send" | "receive";
/** Errors the screen explains: the transfer's own, or that the endpoint did not open. */
export type TransferProblem = TransferErrorCode | "openFailed";

export type TransferApi = Pick<
  typeof api,
  | "transferOpen"
  | "transferClose"
  | "transferOffer"
  | "transferSendStatus"
  | "transferDecide"
  | "transferCancelSend"
  | "transferReceive"
  | "transferReceiveStatus"
  | "transferCancelReceive"
  | "transferResumable"
  | "transferResume"
  | "transferPause"
  | "transferForeground"
  | "transferForegroundStop"
  | "transferNotifications"
>;

export type TransferDeps = {
  api: TransferApi;
  translate: (key: string, vars?: Record<string, unknown>) => string;
  setTimer: (fn: () => void, ms: number) => number;
  now: () => number;
  /** Something arrived in the library (refresh listings). */
  onReceived: (documentIds: string[]) => void;
};

export type TransferState = {
  info: TransferInfo | null;
  opening: boolean;
  openFailed: boolean;
  tab: TransferTab;
  preparing: boolean;
  offer: OfferView | null;
  send: SendView | null;
  sendProblem: TransferProblem | null;
  receiveId: string | null;
  receive: ReceiveView | null;
  receiveProblem: TransferProblem | null;
  resumable: ResumableView[];
  /** A deep link waiting for the endpoint to open. */
  incomingLink: string | null;

  open: () => Promise<void>;
  setIncomingLink: (link: string) => void;
  close: () => Promise<void>;
  setTab: (tab: TransferTab) => void;
  offerDocuments: (ids: string[], includeHistory: boolean) => Promise<void>;
  decide: (confirm: boolean) => Promise<void>;
  cancelSend: () => Promise<void>;
  resetSend: () => void;
  receiveLink: (input: string) => Promise<void>;
  resume: (id: string) => Promise<void>;
  discard: (id: string) => Promise<void>;
  cancelReceive: () => Promise<void>;
  resetReceive: () => void;
  /** Android's daily foreground-service limit: stop receives, keep them resumable. */
  pauseAll: () => Promise<void>;
};

/** How often a running transfer is looked at. */
export const POLL_MS = 400;
/** The notification is updated at most this often. */
const NOTIFY_MS = 1_000;

export function sendRunning(view: SendView | null): boolean {
  return view !== null && (view.kind === "confirm" || view.kind === "sending" || view.kind === "interrupted");
}

export function receiveRunning(view: ReceiveView | null): boolean {
  return (
    view !== null &&
    (view.kind === "connecting" ||
      view.kind === "confirm" ||
      view.kind === "receiving" ||
      view.kind === "verifying" ||
      view.kind === "saving")
  );
}

function sendFinished(view: SendView | null): boolean {
  return view?.kind === "done" || view?.kind === "failed";
}

function receiveFinished(view: ReceiveView | null): boolean {
  return view?.kind === "done" || view?.kind === "failed" || view?.kind === "paused";
}

/** What a failed `transfer_receive` call means for the user. */
function receiveCallProblem(err: unknown): TransferProblem {
  if (err instanceof ApiError && err.code === "invalidArgument") {
    if (err.message === "expired") return "expired";
    if (err.message === "invalidLink") return "invalidLink";
    // "the transfer screen is not open"
    return "openFailed";
  }
  return "unreachable";
}

export function createTransferStore(deps: TransferDeps): StoreApi<TransferState> {
  let timer: number | null = null;
  let lastNotify = 0;
  let notifying = false;
  let askedNotifications = false;

  const store = createStore<TransferState>()((set, get) => {
    const schedule = () => {
      if (timer !== null) return;
      const { offer, send, receiveId, receive } = get();
      const active = (offer !== null && !sendFinished(send)) || (receiveId !== null && !receiveFinished(receive));
      if (!active) return;
      timer = deps.setTimer(() => {
        timer = null;
        void tick();
      }, POLL_MS);
    };

    const notify = async () => {
      const { send, receive } = get();
      const sending = send?.kind === "sending" ? send : null;
      const receiving = receive?.kind === "receiving" ? receive : null;
      const running = sending ?? receiving;
      if (!running) {
        if (notifying && !sendRunning(send) && !receiveRunning(receive)) {
          notifying = false;
          await deps.api.transferForegroundStop().catch(() => undefined);
        }
        return;
      }
      if (deps.now() - lastNotify < NOTIFY_MS) return;
      lastNotify = deps.now();
      notifying = true;
      if (!askedNotifications) {
        askedNotifications = true;
        // Not awaited: the system dialog waits for the user, progress must not.
        void deps.api.transferNotifications().catch(() => false);
      }
      const pct = percent(running.bytes, running.total);
      await deps.api
        .transferForeground(
          deps.translate("transfer.notify.channel"),
          deps.translate(sending ? "transfer.notify.sending" : "transfer.notify.receiving"),
          deps.translate("transfer.notify.progress", { percent: pct }),
          pct,
          100,
        )
        .catch(() => undefined);
    };

    const tick = async () => {
      const { offer, send, receiveId, receive } = get();
      if (offer && !sendFinished(send)) {
        try {
          const view = await deps.api.transferSendStatus(offer.sessionId);
          if (get().offer?.sessionId === offer.sessionId) set({ send: view });
        } catch {
          // The endpoint went away (screen closed for good): the offer is over.
          if (get().offer?.sessionId === offer.sessionId) set({ send: { kind: "failed", error: "cancelled" } });
        }
      }
      if (receiveId && !receiveFinished(receive)) {
        try {
          const view = await deps.api.transferReceiveStatus(receiveId);
          if (get().receiveId === receiveId) {
            set({ receive: view });
            if (view.kind === "done") deps.onReceived(view.documentIds);
            if (receiveFinished(view)) void loadResumable();
          }
        } catch {
          // Keep the last view; the next tick asks again.
        }
      }
      await notify();
      schedule();
    };

    const loadResumable = async () => {
      try {
        set({ resumable: await deps.api.transferResumable() });
      } catch {
        // Not essential: the list stays as it was.
      }
    };

    return {
      info: null,
      opening: false,
      openFailed: false,
      tab: "send",
      preparing: false,
      offer: null,
      send: null,
      sendProblem: null,
      receiveId: null,
      receive: null,
      receiveProblem: null,
      resumable: [],
      incomingLink: null,

      open: async () => {
        if (get().opening) return;
        set({ opening: true, openFailed: false });
        try {
          const info = await deps.api.transferOpen();
          set({ info, opening: false });
          await loadResumable();
        } catch {
          set({ opening: false, openFailed: true });
          return;
        }
        const link = get().incomingLink;
        if (link) {
          set({ incomingLink: null });
          await get().receiveLink(link);
        }
      },

      setIncomingLink: (link) => {
        set({ tab: "receive" });
        if (get().info && !get().opening) {
          void get().receiveLink(link);
        } else {
          set({ incomingLink: link });
        }
      },

      close: async () => {
        try {
          const closed = await deps.api.transferClose(false);
          if (closed) {
            const { send } = get();
            // An offer dies with the endpoint.
            set({ info: null, ...(sendFinished(send) || sendRunning(send) ? {} : { offer: null, send: null }) });
          }
        } catch {
          // Closing again later is harmless.
        }
      },

      setTab: (tab) => set({ tab }),

      offerDocuments: async (ids, includeHistory) => {
        if (get().preparing || ids.length === 0) return;
        set({ preparing: true, sendProblem: null });
        try {
          const offer = await deps.api.transferOffer(ids, includeHistory);
          set({ offer, send: { kind: "waitingForReceiver" }, preparing: false });
          schedule();
        } catch (err) {
          set({
            preparing: false,
            sendProblem: err instanceof ApiError && err.code === "invalidArgument" ? "openFailed" : "storage",
          });
        }
      },

      decide: async (confirm) => {
        const offer = get().offer;
        if (!offer) return;
        try {
          await deps.api.transferDecide(offer.sessionId, confirm);
        } catch {
          // Already decided (a repeated tap): the status shows what happened.
        }
        schedule();
      },

      cancelSend: async () => {
        const offer = get().offer;
        set({ offer: null, send: null, sendProblem: null });
        if (offer) await deps.api.transferCancelSend(offer.sessionId).catch(() => undefined);
        await notify();
      },

      resetSend: () => set({ offer: null, send: null, sendProblem: null }),

      receiveLink: async (input) => {
        set({ tab: "receive", receiveProblem: null });
        const link = cleanLink(input);
        if (!link) {
          set({ receiveProblem: "invalidLink" });
          return;
        }
        if (receiveRunning(get().receive)) return;
        set({ receive: { kind: "connecting" }, receiveId: null });
        try {
          const id = await deps.api.transferReceive(link);
          set({ receiveId: id });
          schedule();
        } catch (err) {
          set({ receive: null, receiveProblem: receiveCallProblem(err) });
        }
      },

      resume: async (id) => {
        set({ tab: "receive", receiveProblem: null, receiveId: id, receive: { kind: "connecting" } });
        try {
          await deps.api.transferResume(id);
          schedule();
        } catch {
          set({ receive: null, receiveId: null, receiveProblem: "unknown" });
          await loadResumable();
        }
      },

      discard: async (id) => {
        await deps.api.transferCancelReceive(id).catch(() => undefined);
        if (get().receiveId === id) set({ receiveId: null, receive: null });
        await loadResumable();
      },

      cancelReceive: async () => {
        const id = get().receiveId;
        set({ receiveId: null, receive: null, receiveProblem: null });
        if (id) await deps.api.transferCancelReceive(id).catch(() => undefined);
        await notify();
        await loadResumable();
      },

      resetReceive: () => set({ receiveId: null, receive: null, receiveProblem: null }),

      pauseAll: async () => {
        await deps.api.transferPause().catch(() => undefined);
        schedule();
      },
    };
  });
  return store;
}

let instance: StoreApi<TransferState> | null = null;
const receivedListeners = new Set<(ids: string[]) => void>();

/** Library listings refresh when documents arrive (TransferScreen subscribes). */
export function onDocumentsReceived(listener: (ids: string[]) => void): () => void {
  receivedListeners.add(listener);
  return () => receivedListeners.delete(listener);
}

export function transferStore(): StoreApi<TransferState> {
  instance ??= createTransferStore({
    api,
    translate: (key, vars) => (vars ? i18n.t(key, vars) : i18n.t(key)),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    now: () => Date.now(),
    onReceived: (ids) => {
      for (const listener of receivedListeners) listener(ids);
    },
  });
  return instance;
}

export function useTransfer<T>(selector: (state: TransferState) => T): T {
  return useStore(transferStore(), selector);
}
