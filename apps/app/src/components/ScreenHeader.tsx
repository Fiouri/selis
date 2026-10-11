import type { ReactNode } from "react";

type Props = {
  title: string;
  /** Right-aligned icon buttons. */
  actions?: ReactNode;
};

/**
 * Large-title header (docs/design/p1-ui-brief.md, Global): 52 px below the safe
 * area, title 28 px / 700 / -0.02em, 20 px left padding, icon buttons right.
 */
export function ScreenHeader({ title, actions }: Props) {
  return (
    <header style={{ paddingTop: "var(--safe-top)" }}>
      <div className="flex h-13 items-center justify-between gap-2 pr-2 pl-5">
        <h1 className="min-w-0 truncate text-[28px] leading-tight font-bold tracking-[-0.02em] text-neutral-12">{title}</h1>
        {actions ? <div className="flex shrink-0 items-center">{actions}</div> : null}
      </div>
    </header>
  );
}
