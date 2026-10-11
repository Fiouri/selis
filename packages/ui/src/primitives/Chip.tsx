import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

export type ChipProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-pressed"> & {
  pressed: boolean;
  icon?: ReactNode;
};

/** Filter chip: 44 high, fully rounded, 14 px. Active = inverted (neutral-12 on neutral-1). */
export function Chip({ pressed, icon, className, children, type = "button", ...rest }: ChipProps) {
  return (
    <button
      type={type}
      aria-pressed={pressed}
      className={cx(
        "selis-focus inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full px-4 text-sm whitespace-nowrap",
        "transition-colors duration-150 ease-standard",
        pressed
          ? "bg-neutral-12 font-semibold text-neutral-1"
          : "border border-neutral-6 font-medium text-neutral-11 hover:bg-neutral-3 active:bg-neutral-4",
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}
