import { Button, EmptyState, IconButton, Skeleton } from "@selis/ui";
import { ArrowLeft } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DocumentGlyph } from "../components/Illustrations";
import { PdfViewer, type PdfViewerHandle } from "../features/viewer/PdfViewer";
import { type OpenState, useOpenDocument } from "../features/viewer/useOpenDocument";
import { isMobilePlatform } from "../lib/platform";
import { useNavigation } from "../state/navigation";

/** Per-bitmap pixel budget: ~32 MB RGBA on mobile, ~64 MB on desktop. */
export const PAGE_PIXEL_BUDGET = isMobilePlatform ? 8_000_000 : 16_000_000;
const THUMB_PIXEL_BUDGET = 250_000;

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
    <div className="h-full overflow-hidden bg-page-canvas px-2" style={{ paddingTop: insetTop + 8 }} aria-busy="true">
      <span className="sr-only">{t("viewer.loading")}</span>
      <Skeleton className="w-full rounded-none" style={{ aspectRatio: "595 / 842" }} />
    </div>
  );
}

type Variant = "phone" | "tablet";

/**
 * Full-bleed document view. Phone: pages scroll under a translucent top bar
 * that a tap hides. Tablet: thumbnails strip + page.
 */
export function ViewerScreen({ docId, variant }: { docId: string; variant: Variant }) {
  const { t } = useTranslation();
  const back = useNavigation((s) => s.back);
  const state = useOpenDocument(docId);
  const [chrome, setChrome] = useState(true);
  const [page, setPage] = useState(0);
  const [barHeight, setBarHeight] = useState(0);
  const barRef = useRef<HTMLElement>(null);
  const mainRef = useRef<PdfViewerHandle>(null);

  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const measure = () => setBarHeight(bar.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);

  const onPageChange = useCallback((index: number) => setPage(index), []);
  const toggleChrome = useCallback(() => setChrome((c) => !c), []);
  const jumpTo = useCallback((index: number) => mainRef.current?.scrollToPage(index), []);

  const title =
    state.status === "ready" ? (state.meta.title || state.doc.title || t("library.untitled")) : "";
  const showChrome = chrome || state.status !== "ready";

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
        insetBottom={variant === "phone" ? 72 : 16}
        gutter={variant === "phone" ? 8 : 24}
        maxPixels={PAGE_PIXEL_BUDGET}
        onPageChange={onPageChange}
        onTap={variant === "phone" ? toggleChrome : undefined}
        testId="pdf-viewer"
        ariaLabel={title}
      />
    );
    body =
      variant === "tablet" ? (
        <div className="flex h-full">
          <aside className="h-full w-44 shrink-0 border-r border-neutral-5" aria-label={t("viewer.pageIndicator", { page: page + 1, total: state.doc.pageCount })}>
            <PdfViewer
              doc={state.doc}
              insetTop={barHeight}
              gutter={20}
              gap={16}
              zoomable={false}
              buffer={3}
              maxPixels={THUMB_PIXEL_BUDGET}
              activePage={page}
              onPageClick={jumpTo}
              testId="thumbnails"
            />
          </aside>
          <div className="h-full min-w-0 flex-1">{main}</div>
        </div>
      ) : (
        main
      );
  }

  return (
    <div className="relative h-full w-full overflow-hidden bg-page-canvas" data-testid="viewer-screen">
      {body}
      <header
        ref={barRef}
        className="absolute inset-x-0 top-0 z-10 flex items-center gap-1 border-b border-neutral-5 bg-surface-app/90 pr-4 pb-1 backdrop-blur-md transition-transform duration-200 ease-standard"
        style={{
          paddingTop: "calc(var(--safe-top) + 4px)",
          paddingLeft: "calc(var(--safe-left) + 4px)",
          transform: showChrome ? "none" : "translateY(-100%)",
        }}
      >
        <IconButton label={t("viewer.back")} icon={<ArrowLeft size={22} strokeWidth={1.75} />} onClick={back} />
        <h1 className="min-w-0 flex-1 truncate text-md font-medium text-neutral-12">{title}</h1>
      </header>
      {state.status === "ready" && variant === "phone" ? (
        <div
          className="pointer-events-none absolute inset-x-0 z-10 flex justify-center transition-opacity duration-200 ease-standard"
          style={{ bottom: "calc(var(--safe-bottom) + 16px)", opacity: showChrome ? 1 : 0 }}
        >
          <span className="rounded-full bg-neutral-12/85 px-3 py-1.5 text-sm font-medium text-neutral-1 tabular-nums shadow-2" data-testid="page-indicator">
            {t("viewer.pageIndicator", { page: page + 1, total: state.doc.pageCount })}
          </span>
        </div>
      ) : null}
    </div>
  );
}
