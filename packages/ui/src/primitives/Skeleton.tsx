import type { CSSProperties } from "react";
import { cx } from "./cx";

export type SkeletonProps = {
  className?: string;
  style?: CSSProperties;
};

/** Fixed-size placeholder; give it the final size so nothing shifts on load. */
export function Skeleton({ className, style }: SkeletonProps) {
  return <div aria-hidden="true" className={cx("selis-skeleton rounded-control", className)} style={style} />;
}
