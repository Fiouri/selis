import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

export type ChipProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-pressed" | "aria-checked" | "role"> & {
  /** Shown active (inverted). */
  selected: boolean;
  /**
   * How assistive tech hears the state: "radio" — one choice of a `role="radiogroup"`
   * ("Favorites, radio button, checked"); "menu" — opens a picker and its text says what is
   * chosen (no state). TalkBack reads aria-pressed as "Switch", which a choice is not.
   */
  kind: "radio" | "menu";
  icon?: ReactNode;
};

/** Filter chip: 44 high, fully rounded, 14 px. Active = inverted (neutral-12 on neutral-1). */
export function Chip({ selected, kind, icon, className, children, type = "button", ...rest }: ChipProps) {
  return (
    <button
      type={type}
      role={kind === "radio" ? "radio" : undefined}
      aria-checked={kind === "radio" ? selected : undefined}
      className={cx(
        "selis-focus inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full px-4 text-sm whitespace-nowrap",
        "transition-colors duration-150 ease-standard",
        selected
          ? "bg-neutral-12 font-semibold text-neutral-1"
          : "border border-control-line font-medium text-neutral-11 hover:bg-neutral-3 active:bg-neutral-4",
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}
