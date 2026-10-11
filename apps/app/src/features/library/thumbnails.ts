/**
 * Page-1 thumbnails for the library. Rendered and encoded off the main thread
 * by the engine worker (packages/engine), stored by Rust (`thumbs/`, LRU 300 MB).
 *
 * - The viewer makes one from the document it already has open (no second load).
 * - Cards without one queue a background job: one document at a time, only
 *   while no document is open, after the screen has settled. Documents that
 *   cannot be rendered (password, damaged) are skipped for the session.
 */
import type { DocHandle, Thumbnail } from "@selis/engine";
import type { QueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { api, type Document } from "../../lib/api";
import { getEngine } from "../../lib/engine";
import { readDocumentBytes } from "../../lib/files";
import { useNavigation } from "../../state/navigation";
import { patchCachedDocument } from "./queries";

/** Device pixels: sharp at ~2× for the 128×176 card thumbnail. */
export const THUMB_MAX_WIDTH = 300;
export const THUMB_MAX_HEIGHT = 420;
/** Background jobs read the whole file into the worker; skip very large ones. */
const MAX_BACKGROUND_BYTES = 150 * 1024 * 1024;
const START_DELAY_MS = 800;
const BETWEEN_JOBS_MS = 150;

type ThumbnailStatus = { failed: ReadonlySet<string> };

/** Documents whose thumbnail could not be made this session (cards show a glyph). */
export const useThumbnailStatus = create<ThumbnailStatus>()(() => ({ failed: new Set<string>() }));

function markFailed(id: string): void {
  useThumbnailStatus.setState((s) => ({ failed: new Set(s.failed).add(id) }));
}

const attempted = new Set<string>();
const queue: Document[] = [];
let running = false;

async function store(queryClient: QueryClient, id: string, thumb: Thumbnail): Promise<void> {
  const saved = await api.saveThumbnail(id, new Uint8Array(thumb.bytes));
  patchCachedDocument(queryClient, saved);
}

async function generate(queryClient: QueryClient, doc: Document): Promise<void> {
  const file = await api.documentFile(doc.id);
  const bytes = await readDocumentBytes(file.path);
  const handle = await getEngine().open(bytes);
  try {
    await store(queryClient, doc.id, await handle.renderThumbnail(0, THUMB_MAX_WIDTH, THUMB_MAX_HEIGHT));
  } finally {
    await handle.close();
  }
}

const sleep = (ms: number) =>
  new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });

function viewerOpen(): boolean {
  return useNavigation.getState().route.docId !== null;
}

async function drain(queryClient: QueryClient): Promise<void> {
  if (running) return;
  running = true;
  try {
    await sleep(START_DELAY_MS);
    for (let doc = queue.shift(); doc; doc = queue.shift()) {
      // The viewer needs the worker (and the memory) more than the grid does.
      while (viewerOpen()) await sleep(1_000);
      try {
        await generate(queryClient, doc);
      } catch (err) {
        console.warn(`selis: no thumbnail for ${doc.id}`, err);
        markFailed(doc.id);
      }
      await sleep(BETWEEN_JOBS_MS);
    }
  } finally {
    running = false;
  }
}

/** Queues a background thumbnail for a document that has none (once per session). */
export function requestThumbnail(queryClient: QueryClient, doc: Document): void {
  if (attempted.has(doc.id)) return;
  attempted.add(doc.id);
  if (doc.sizeBytes > MAX_BACKGROUND_BYTES) {
    markFailed(doc.id);
    return;
  }
  queue.push(doc);
  void drain(queryClient);
}

/** A stored thumbnail failed to load (file evicted or deleted): make it again. */
export function thumbnailBroken(queryClient: QueryClient, doc: Document): void {
  attempted.delete(doc.id);
  requestThumbnail(queryClient, { ...doc, thumbnailPath: null });
}

/** Called by the viewer once a document without a thumbnail is open. */
export function thumbnailFromOpenDocument(queryClient: QueryClient, meta: Document, handle: DocHandle): void {
  if (meta.thumbnailPath !== null || attempted.has(meta.id)) return;
  attempted.add(meta.id);
  void (async () => {
    try {
      await store(queryClient, meta.id, await handle.renderThumbnail(0, THUMB_MAX_WIDTH, THUMB_MAX_HEIGHT));
    } catch (err) {
      // Closed before it was done (viewer left early): the library queues it later.
      attempted.delete(meta.id);
      console.warn(`selis: thumbnail for ${meta.id} not made from the viewer`, err);
    }
  })();
}
