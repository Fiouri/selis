import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost";
  icon?: ReactNode;
};

const VARIANTS: Record<NonNullable<ButtonProps["variant"]>, string> = {
  primary: "bg-accent-9 text-accent-contrast hover:bg-accent-10 active:bg-accent-10 shadow-1",
  secondary: "bg-neutral-3 text-neutral-12 hover:bg-neutral-4 active:bg-neutral-5 border border-neutral-6",
  ghost: "bg-transparent text-accent-11 hover:bg-neutral-3 active:bg-neutral-4",
};

export function Button({ variant = "primary", icon, className, children, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        "selis-focus inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-control px-5",
        "text-md font-medium select-none transition-colors duration-150 ease-standard",
        "disabled:pointer-events-none disabled:opacity-50",
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}
