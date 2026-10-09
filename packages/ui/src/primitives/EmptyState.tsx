import type { ReactNode } from "react";

export type EmptyStateProps = {
  illustration: ReactNode;
  title: string;
  body: string;
  /** The one clear action. */
  action?: ReactNode;
};

export function EmptyState({ illustration, title, body, action }: EmptyStateProps) {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center gap-5 px-6 py-12 text-center">
      <div className="text-neutral-8" aria-hidden="true">
        {illustration}
      </div>
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-neutral-12">{title}</h2>
        <p className="text-sm text-neutral-11">{body}</p>
      </div>
      {action}
    </div>
  );
}
