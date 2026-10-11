import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label"> & {
  /** Accessible name — required, icon buttons have no visible text. */
  label: string;
  icon: ReactNode;
};

export function IconButton({ label, icon, className, type = "button", ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cx(
        "selis-focus inline-flex size-11 shrink-0 items-center justify-center rounded-full text-neutral-12",
        "transition-colors duration-150 ease-standard hover:bg-neutral-3 active:bg-neutral-4",
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...rest}
    >
      {icon}
    </button>
  );
}
