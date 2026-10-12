import { nextTurn, type QuarterTurns } from "@selis/engine";
import { Button, EmptyState, Skeleton } from "@selis/ui";
import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DocumentGlyph } from "../components/Illustrations";
import { useToast } from "../components/Toast";
import { AnnotateBar, ToolSheet } from "../features/annotate/AnnotateChrome";
import { AnnotationLayer } from "../features/annotate/AnnotationLayer";
import type { EditSession, SaveStatus, SessionState } from "../features/annotate/session";
import { FormBanner, FormSheet } from "../features/forms/FormChrome";
import { FormLayer } from "../features/forms/FormLayer";
import { flattenCommand, useFormState } from "../features/forms/formState";
import { useDocStructure } from "../features/pages/pageCommands";
import { PagesMode } from "../features/pages/PagesMode";
import { RedactLayer } from "../features/redact/RedactLayer";
import { applyCommand, discardCommand, useRedactState } from "../features/redact/redactState";
import { RedactSheet } from "../features/redact/RedactSheet";
import { SignatureLayer, useSignState } from "../features/sign/SignatureLayer";
import { SignSheet } from "../features/sign/SignSheet";
import { PdfViewer, type PdfViewerHandle, type ScrollInfo } from "../features/viewer/PdfViewer";
import { shareDocument } from "../features/viewer/share";
import { type OpenState, useOpenDocument } from "../features/viewer/useOpenDocument";
import { useDocumentSearch } from "../features/viewer/useDocumentSearch";
import { PageChip, Scrubber, ViewerDock, ViewerSearchBar, ViewerTopBar } from "../features/viewer/ViewerChrome";
import { OutlineSheet, ThumbnailsSheet, ViewerMoreSheet } from "../features/viewer/ViewerSheets";
import { api } from "../lib/api";
import { currentRenderLimits } from "../lib/engine";
import { useNavigation, useOverlay } from "../state/navigation";
import { useSettings } from "../state/settings";

const THUMB_PIXEL_BUDGET = 250_000;
/** Page chip and scrubber fade out this long after scrolling stops. */
const CHIP_HIDE_MS = 1_500;
/** Reading position is saved after the reader settles on a page. */
const SAVE_PAGE_MS = 800;
/** Room under the last page for the floating dock (64 + 28 + breathing room). */
const DOCK_SPACE = 112;
/** Scrolling this far down hides the dock; up shows it again. */
const DOCK_SCROLL_PX = 8;

function errorBody(state: Extract<OpenState, { status: "error" }>): string {
  switch (state.code) {
    case "password":
      return "viewer.errorPassword";
    case "format":
      return "viewer.errorFormat";
    default:
      return "viewer.errorGeneric";
  }
}

/** Fixed-geometry placeholder (A4 ratio) shown while the document opens. */
function ViewerSkeleton({ insetTop }: { insetTop: number }) {
  const { t } = useTranslation();
  return (
    <div className="h-full overflow-hidden bg-page-canvas px-4" style={{ paddingTop: insetTop + 12 }} aria-busy="true">
      <span className="sr-only">{t("viewer.loading")}</span>
      <Skeleton className="w-full rounded-[2px]" style={{ aspectRatio: "595 / 842" }} />
    </div>
  );
}

type Variant = "phone" | "tablet";
type ViewerSheet = "more" | "outline" | "thumbnails" | null;
type Mode = "view" | "annotate" | "sign" | "form" | "pages" | "redact";

const MODE_TITLES: Record<Exclude<Mode, "view" | "pages">, { title: string; close: string }> = {
  annotate: { title: "annotate.title", close: "annotate.close" },
  sign: { title: "sign.title", close: "sign.close" },
  form: { title: "forms.title", close: "forms.close" },
  redact: { title: "redact.title", close: "redact.close" },
};

const NO_SESSION: SessionState = { status: "saved", canUndo: false, canRedo: false, undoTool: null };
const noop = () => () => undefined;

function useSessionState(session: EditSession | null): SessionState {
  return useSyncExternalStore(session?.subscribe ?? noop, session?.getState ?? (() => NO_SESSION));
}

const STATUS_KEYS: Record<SaveStatus, string> = {
  saved: "annotate.statusSaved",
  autosaved: "annotate.statusSaved",
  saving: "annotate.statusSaving",
  error: "annotate.statusError",
};

/**
 * Document view (docs/design/p1-ui-brief.md §2): top bar with title and page,
 * page chip, scrubber, floating dock, search, outline / thumbnails sheets,
 * rotate and night mode. Tablet adds a thumbnails strip.
 */
export function ViewerScreen({ docId, variant }: { docId: string; variant: Variant }) {
  const { t } = useTranslation();
  const back = useNavigation((s) => s.back);
  const showToast = useToast((s) => s.show);
  const night = useSettings((s) => s.nightMode);
  const setNight = useSettings((s) => s.setNightMode);
  const state = useOpenDocument(docId);
  const [chrome, setChrome] = useState(true);
  const [dockHidden, setDockHidden] = useState(false);
  const [page, setPage] = useState(0);
  const [fraction, setFraction] = useState(0);
  const [scrolling, setScrolling] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [barHeight, setBarHeight] = useState(0);
  const [rotation, setRotation] = useState<QuarterTurns>(0);
  const [sheet, setSheet] = useState<ViewerSheet>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<Mode>("view");
  const [sheetHeight, setSheetHeight] = useState(0);
  const barRef = useRef<HTMLElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const mainRef = useRef<PdfViewerHandle>(null);
  const hideTimer = useRef<number | null>(null);

  const doc = state.status === "ready" ? state.doc : null;
  const session = state.status === "ready" ? state.session : null;
  const sessionState = useSessionState(session);
  // Any editing mode (annotate, sign, form, pages): its own top bar and bottom sheet / bar.
  const editing = mode !== "view" && doc !== null && session !== null;
  const annotating = editing && mode !== "pages";
  const pagesMode = editing && mode === "pages";
  // Page operations (and their undo) replace the list of pages: the viewer is
  // rebuilt for it and resumes at the same page number (or the last one).
  const structure = useDocStructure(doc);
  const [seenStructure, setSeenStructure] = useState(structure);
  const [resumePage, setResumePage] = useState<number | null>(null);
  if (structure !== seenStructure && doc) {
    setSeenStructure(structure);
    const clamped = Math.min(page, doc.pageCount - 1);
    setResumePage(clamped);
    setPage(clamped);
  }
  const search = useDocumentSearch(searching ? doc : null, query);

  const closeSearch = useCallback(() => {
    setSearching(false);
    setQuery("");
  }, []);
  useOverlay(searching, closeSearch);

  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const measure = () => setBarHeight(bar.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => observer.disconnect();
    // Each of these swaps the top bar for another element: measure the new one.
  }, [searching, annotating, pagesMode]);

  // The tool sheet covers the bottom of the pages: reserve its height.
  useLayoutEffect(() => {
    const sheetEl = sheetRef.current;
    if (!annotating || !sheetEl) {
      setSheetHeight(0);
      return;
    }
    const measure = () => setSheetHeight(sheetEl.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(sheetEl);
    return () => observer.disconnect();
  }, [annotating]);

  // Leaving the app (switch, lock): write the working copy now, it may be killed.
  useEffect(() => {
    if (!session) return;
    const onHide = () => {
      if (document.visibilityState === "hidden") void session.autosave().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [session]);

  const recovered = state.status === "ready" && state.recovered;
  useEffect(() => {
    if (recovered) showToast(t("recovery.restored"));
  }, [recovered, showToast, t]);

  // The form's fields, for the banner and form mode (empty without an AcroForm).
  const setFormFields = useFormState((s) => s.setFields);
  useEffect(() => {
    if (!doc) return;
    const request = { live: true };
    void (async () => {
      try {
        const fields = await doc.documentFields();
        if (request.live) setFormFields(fields);
      } catch (err) {
        console.warn("selis: form fields unavailable", err);
      }
    })();
    return () => {
      request.live = false;
      setFormFields(null);
    };
  }, [doc, structure, setFormFields]);

  // The library shows the page count: keep it right after page operations.
  useEffect(() => {
    if (!doc || structure === 0) return;
    void api.recordDocumentInfo(docId, doc.pageCount, null).catch(() => undefined);
  }, [doc, docId, structure]);

  /**
   * Leaves the editing mode; the session's edits become a version. Redaction
   * marks that were not applied are taken away first: a saved version never
   * shows a black box over content that is still there.
   */
  const finishAnnotating = useCallback(() => {
    setMode("view");
    // Back in view mode the actions show again, even if the page scrolled down meanwhile.
    setDockHidden(false);
    useSignState.getState().activate(null);
    useFormState.getState().setActive(null);
    if (!session || !doc) return;
    const pending = [...useRedactState.getState().marks.values()];
    void (async () => {
      try {
        if (pending.length > 0) {
          await session.run(discardCommand(doc, pending));
          showToast(t("redact.discarded", { count: pending.length }));
        }
        await session.commit();
      } catch (err) {
        console.warn("selis: saving the annotations failed", err);
        showToast(t("annotate.saveFailed"), "error");
      }
    })();
  }, [session, doc, showToast, t]);
  useOverlay(annotating, finishAnnotating);

  const startEditing = (next: Exclude<Mode, "view">) => {
    // Back from the pages grid, the viewer opens at the page it was on.
    if (next === "pages") setResumePage(page);
    // Editing works on the unrotated page with the chrome shown.
    setRotation(0);
    setSearching(false);
    setQuery("");
    setSheet(null);
    setChrome(true);
    setDockHidden(false);
    setMode(next);
  };

  const [confirmRedact, setConfirmRedact] = useState(false);
  const [redacting, setRedacting] = useState(false);
  const redactCount = useRedactState((s) => s.marks.size);
  const applyRedactions = async () => {
    setConfirmRedact(false);
    if (!doc || !session) return;
    setRedacting(true);
    try {
      await session.run(applyCommand(doc, (count) => showToast(t("redact.applied", { count }))));
    } catch (err) {
      console.warn("selis: redaction failed", err);
      showToast(t("redact.failed"), "error");
    } finally {
      setRedacting(false);
    }
  };

  const flatten = async () => {
    if (!doc || !session) return;
    try {
      await session.run(flattenCommand(doc));
      showToast(t("forms.flattened"));
    } catch (err) {
      console.warn("selis: flatten failed", err);
      showToast(t("annotate.failed"), "error");
    }
  };

  const undo = () => {
    session?.undo().catch(() => showToast(t("annotate.failed"), "error"));
  };
  const redo = () => {
    session?.redo().catch(() => showToast(t("annotate.failed"), "error"));
  };

  const renderOverlay = useCallback(
    (index: number, scale: number) => {
      if (!doc || !session) return null;
      if (mode === "sign") return <SignatureLayer doc={doc} index={index} scale={scale} session={session} />;
      if (mode === "form") return <FormLayer doc={doc} index={index} scale={scale} session={session} />;
      if (mode === "redact") return <RedactLayer doc={doc} index={index} scale={scale} session={session} />;
      return <AnnotationLayer doc={doc} index={index} scale={scale} session={session} />;
    },
    [doc, session, mode],
  );

  // Remember the reading position (debounced), and once more when leaving.
  const pageRef = useRef(page);
  useEffect(() => {
    pageRef.current = page;
    if (state.status !== "ready") return;
    const timer = window.setTimeout(() => {
      void api.setLastPage(docId, page).catch(() => undefined);
    }, SAVE_PAGE_MS);
    return () => window.clearTimeout(timer);
  }, [page, docId, state.status]);
  useEffect(
    () => () => {
      void api.setLastPage(docId, pageRef.current).catch(() => undefined);
    },
    [docId],
  );

  // Jump to the active search match.
  const current = search.current;
  useEffect(() => {
    if (current) mainRef.current?.scrollToPage(current.page, Math.max(0, (current.rects[0]?.y ?? 0) - 48));
  }, [current]);

  useEffect(
    () => () => {
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    },
    [],
  );

  const onPageChange = useCallback((index: number) => setPage(index), []);
  const toggleChrome = useCallback(() => {
    setChrome((c) => !c);
    setDockHidden(false);
  }, []);
  const onScroll = useCallback((info: ScrollInfo) => {
    setFraction(info.fraction);
    setScrolling(true);
    if (info.delta > DOCK_SCROLL_PX) setDockHidden(true);
    else if (info.delta < -DOCK_SCROLL_PX) setDockHidden(false);
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setScrolling(false), CHIP_HIDE_MS);
  }, []);
  const jumpTo = useCallback((index: number) => mainRef.current?.scrollToPage(index), []);
  const jumpFromSheet = (index: number) => {
    setSheet(null);
    mainRef.current?.scrollToPage(index);
  };

  const share = async () => {
    if (state.status !== "ready") return;
    const title = state.meta.title || state.doc.title || t("library.untitled");
    const result = await shareDocument(docId, title, state.path);
    if (result === "unsupported") showToast(t("viewer.shareUnsupported"));
    else if (result === "failed") showToast(t("viewer.shareFailed"), "error");
  };

  const title = state.status === "ready" ? state.meta.title || state.doc.title || t("library.untitled") : "";
  const total = doc?.pageCount ?? 0;
  const subtitle = doc ? t("viewer.pageIndicator", { page: page + 1, total }) : "";
  const saveStatus = doc ? t(STATUS_KEYS[sessionState.status]) : "";
  const showChrome = chrome || state.status !== "ready" || searching || annotating;
  const initialPage = Math.min(total - 1, Math.max(0, resumePage ?? (state.status === "ready" ? (state.meta.lastPage ?? 0) : 0)));
  const searchStatus =
    query.trim() === ""
      ? ""
      : search.matches.length > 0
        ? t("viewer.searchCount", { current: search.active + 1, total: search.matches.length })
        : search.done
          ? t("viewer.searchNone")
          : t("viewer.searching");

  let body;
  if (state.status === "loading" || state.status === "recovery") {
    body = <ViewerSkeleton insetTop={barHeight} />;
  } else if (state.status === "error") {
    body = (
      <div className="flex h-full items-center justify-center" style={{ paddingTop: barHeight }}>
        <EmptyState
          illustration={<DocumentGlyph />}
          title={t("viewer.errorTitle")}
          body={t(errorBody(state))}
          action={
            <Button variant="secondary" onClick={back}>
              {t("viewer.back")}
            </Button>
          }
        />
      </div>
    );
  } else if (mode === "pages" && session) {
    body = (
      <PagesMode
        doc={state.doc}
        session={session}
        sessionState={sessionState}
        structure={structure}
        title={title}
        onClose={finishAnnotating}
      />
    );
  } else {
    const main = (
      <PdfViewer
        key={structure}
        ref={mainRef}
        doc={state.doc}
        insetTop={barHeight}
        insetBottom={annotating ? sheetHeight + 16 : DOCK_SPACE}
        gutter={variant === "phone" ? 16 : 24}
        gap={12}
        maxPixels={currentRenderLimits().maxBitmapPixels}
        rotation={rotation}
        night={night && !annotating}
        textLayer={!annotating}
        highlights={searching ? search.highlights : undefined}
        initialPage={initialPage}
        onPageChange={onPageChange}
        onTap={annotating ? undefined : toggleChrome}
        onScroll={onScroll}
        testId="pdf-viewer"
        ariaLabel={title}
        renderOverlay={annotating ? renderOverlay : undefined}
      />
    );
    body =
      variant === "tablet" ? (
        <div className="flex h-full">
          <aside className="h-full w-44 shrink-0 border-r border-neutral-5" aria-label={t("viewer.thumbnails")}>
            <PdfViewer
              key={structure}
              doc={state.doc}
              insetTop={barHeight}
              gutter={20}
              gap={16}
              zoomable={false}
              buffer={3}
              maxPixels={THUMB_PIXEL_BUDGET}
              rotation={rotation}
              night={night}
              activePage={page}
              onPageClick={jumpTo}
              testId="thumbnails"
            />
          </aside>
          <div className="relative h-full min-w-0 flex-1">{main}</div>
        </div>
      ) : (
        main
      );
  }

  return (
    <div
      className="relative h-full w-full overflow-hidden bg-page-canvas"
      // What covers the pages (top bar, mode sheet): inline editors keep clear of it (scroll-margin).
      style={{ "--selis-cover-top": `${barHeight}px`, "--selis-cover-bottom": `${sheetHeight}px` } as CSSProperties}
      data-testid="viewer-screen"
    >
      {body}
      {pagesMode ? null : annotating ? (
        <AnnotateBar
          ref={barRef}
          title={t(MODE_TITLES[mode].title)}
          closeLabel={t(MODE_TITLES[mode].close)}
          status={saveStatus}
          canUndo={sessionState.canUndo}
          canRedo={sessionState.canRedo}
          onClose={finishAnnotating}
          onUndo={undo}
          onRedo={redo}
          onDone={finishAnnotating}
        />
      ) : searching ? (
        <ViewerSearchBar
          ref={barRef}
          query={query}
          onQuery={setQuery}
          onClose={closeSearch}
          onNext={search.next}
          onPrevious={search.previous}
          status={searchStatus}
          canStep={search.matches.length > 0}
        />
      ) : (
        <ViewerTopBar
          ref={barRef}
          title={title}
          subtitle={subtitle}
          status={saveStatus}
          onBack={back}
          onSearch={() => setSearching(true)}
          onMore={() => setSheet("more")}
          hidden={!showChrome}
        />
      )}
      {doc && !pagesMode ? (
        <>
          <PageChip page={page + 1} total={total} top={barHeight} visible={(scrolling || dragging) && total > 1} />
          {total > 1 && !annotating ? (
            <Scrubber
              fraction={fraction}
              top={barHeight + 8}
              bottom={DOCK_SPACE}
              visible={scrolling || dragging}
              label={t("viewer.scrubber")}
              onSeek={(f) => mainRef.current?.scrollToFraction(f)}
              onDragging={setDragging}
            />
          ) : null}
          {annotating ? (
            mode === "sign" ? (
              <SignSheet ref={sheetRef} />
            ) : mode === "redact" ? (
              <RedactSheet ref={sheetRef} busy={redacting} onApply={() => setConfirmRedact(true)} />
            ) : mode === "form" ? (
              <FormSheet ref={sheetRef} onJump={(index, y) => mainRef.current?.scrollToPage(index, y)} onFlatten={() => void flatten()} />
            ) : (
              <ToolSheet ref={sheetRef} />
            )
          ) : (
            <ViewerDock
              hidden={!showChrome || (dockHidden && !searching)}
              onSoon={() => showToast(t("viewer.soon"))}
              onShare={() => void share()}
              onAnnotate={() => startEditing("annotate")}
              onSign={() => startEditing("sign")}
              onPages={() => startEditing("pages")}
            />
          )}
          {annotating ? null : <FormBanner top={barHeight} hidden={!showChrome} onFill={() => startEditing("form")} />}
          <ViewerMoreSheet
            open={sheet === "more"}
            onClose={() => setSheet(null)}
            rotation={rotation}
            night={night}
            onOutline={() => setSheet("outline")}
            onThumbnails={() => setSheet("thumbnails")}
            onRotate={() => setRotation((r) => nextTurn(r))}
            onNight={(on) => void setNight(on)}
            onRedact={() => startEditing("redact")}
          />
          <OutlineSheet open={sheet === "outline"} onClose={() => setSheet(null)} doc={doc} onJump={jumpFromSheet} />
          <ThumbnailsSheet
            open={sheet === "thumbnails"}
            onClose={() => setSheet(null)}
            doc={doc}
            current={page}
            onJump={jumpFromSheet}
          />
        </>
      ) : null}
      <ConfirmDialog
        open={confirmRedact}
        danger
        title={t("redact.confirmTitle", { count: redactCount })}
        message={t("redact.confirmBody")}
        confirmLabel={t("redact.confirm")}
        cancelLabel={t("redact.cancel")}
        onConfirm={() => void applyRedactions()}
        onCancel={() => setConfirmRedact(false)}
        testId="redact-dialog"
      />
      <ConfirmDialog
        open={state.status === "recovery"}
        title={t("recovery.title")}
        message={t("recovery.body")}
        confirmLabel={t("recovery.restore")}
        cancelLabel={t("recovery.discard")}
        onConfirm={() => state.status === "recovery" && state.choose("restore")}
        onCancel={() => state.status === "recovery" && state.choose("discard")}
        // Back / outside tap leaves the document; the edits stay for next time.
        onDismiss={back}
        testId="recovery-dialog"
      />
    </div>
  );
}
