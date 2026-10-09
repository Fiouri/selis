import type { ReactNode } from "react";

type Props = {
  title: string;
  subtitle?: string | undefined;
  action?: ReactNode;
};

/** Large-title header that clears the status bar / notch. */
export function ScreenHeader({ title, subtitle, action }: Props) {
  return (
    <header
      className="flex min-h-16 items-end justify-between gap-2 px-4 pb-3"
      style={{ paddingTop: "calc(var(--safe-top) + 16px)" }}
    >
      <div className="flex min-w-0 flex-col">
        <h1 className="truncate text-2xl font-semibold tracking-tight text-neutral-12">{title}</h1>
        {/* Always rendered so the header height never changes when data arrives. */}
        <p className="h-6 truncate text-sm text-neutral-11">{subtitle}</p>
      </div>
      {action}
    </header>
  );
}
