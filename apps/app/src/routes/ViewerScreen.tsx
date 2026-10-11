import { nextTurn, type QuarterTurns } from "@selis/engine";
import { Button, EmptyState, Skeleton } from "@selis/ui";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DocumentGlyph } from "../components/Illustrations";
import { useToast } from "../components/Toast";
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
  const barRef = useRef<HTMLElement>(null);
  const mainRef = useRef<PdfViewerHandle>(null);
  const hideTimer = useRef<number | null>(null);

  const doc = state.status === "ready" ? state.doc : null;
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
  }, [searching]);

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
  const showChrome = chrome || state.status !== "ready" || searching;
  const searchStatus =
    query.trim() === ""
      ? ""
      : search.matches.length > 0
        ? t("viewer.searchCount", { current: search.active + 1, total: search.matches.length })
        : search.done
          ? t("viewer.searchNone")
          : t("viewer.searching");

  let body;
  if (state.status === "loading") {
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
  } else {
    const main = (
      <PdfViewer
        ref={mainRef}
        doc={state.doc}
        insetTop={barHeight}
        insetBottom={DOCK_SPACE}
        gutter={variant === "phone" ? 16 : 24}
        gap={12}
        maxPixels={currentRenderLimits().maxBitmapPixels}
        rotation={rotation}
        night={night}
        textLayer
        highlights={searching ? search.highlights : undefined}
        initialPage={state.meta.lastPage ?? 0}
        onPageChange={onPageChange}
        onTap={toggleChrome}
        onScroll={onScroll}
        testId="pdf-viewer"
        ariaLabel={title}
      />
    );
    body =
      variant === "tablet" ? (
        <div className="flex h-full">
          <aside className="h-full w-44 shrink-0 border-r border-neutral-5" aria-label={t("viewer.thumbnails")}>
            <PdfViewer
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
    <div className="relative h-full w-full overflow-hidden bg-page-canvas" data-testid="viewer-screen">
      {body}
      {searching ? (
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
          onBack={back}
          onSearch={() => setSearching(true)}
          onMore={() => setSheet("more")}
          hidden={!showChrome}
        />
      )}
      {doc ? (
        <>
          <PageChip page={page + 1} total={total} top={barHeight} visible={(scrolling || dragging) && total > 1} />
          {total > 1 ? (
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
          <ViewerDock
            hidden={!showChrome || (dockHidden && !searching)}
            onSoon={() => showToast(t("viewer.soon"))}
            onShare={() => void share()}
          />
          <ViewerMoreSheet
            open={sheet === "more"}
            onClose={() => setSheet(null)}
            rotation={rotation}
            night={night}
            onOutline={() => setSheet("outline")}
            onThumbnails={() => setSheet("thumbnails")}
            onRotate={() => setRotation((r) => nextTurn(r))}
            onNight={(on) => void setNight(on)}
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
    </div>
  );
}
