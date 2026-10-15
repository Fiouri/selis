import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/**
 * A full-screen layer over the tabs (Scan, Images → PDF). Like a sheet it is portalled outside
 * #root, which is inert while the layer is up: TalkBack and the keyboard otherwise reached the
 * library's hidden buttons and tab bar behind the camera (P5b walkthrough). Sheets and dialogs
 * opened inside it keep #root inert (`data-selis-sheet`). No aria-modal (see BottomSheet).
 */
export function FullScreenLayer({ label, className, testId, children }: { label: string; className: string; testId: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = document.getElementById("root");
    root?.setAttribute("inert", "");
    ref.current?.focus();
    return () => {
      if (!document.querySelector("[data-selis-sheet]")) root?.removeAttribute("inert");
      previous?.focus();
    };
  }, []);
  return createPortal(
    <div ref={ref} role="dialog" aria-label={label} tabIndex={-1} className={`fixed inset-0 z-30 flex flex-col outline-none ${className}`} data-selis-sheet="">
      {/* The test id on a wrapper without aria-label: Maestro takes an aria-label as the id. */}
      <div className="flex min-h-0 flex-1 flex-col" data-testid={testId}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
