import { type KeyboardEvent, useRef } from "react";
import { cx } from "./cx";

export type SegmentedOption<T extends string> = { value: T; label: string };

export type SegmentedProps<T extends string> = {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name of the tab list. */
  label: string;
  /** id prefix: tab i is `${idPrefix}-tab-${value}`, its panel `${idPrefix}-panel-${value}`. */
  idPrefix: string;
  testId?: string | undefined;
};

/**
 * Segmented control as a tab list (docs/design/p1-ui-brief.md §5): height 44,
 * padding 3, radius 12, neutral-3 track; the selected segment is raised
 * (surface-raised + shadow-1, radius 9, 14 px / 600). Arrow keys move between
 * tabs (roving tabindex).
 */
export function Segmented<T extends string>({ options, value, onChange, label, idPrefix, testId }: SegmentedProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = options.findIndex((o) => o.value === value);
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0 || index < 0) return;
    event.preventDefault();
    const next = (index + step + options.length) % options.length;
    const option = options[next];
    if (!option) return;
    onChange(option.value);
    refs.current[next]?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="flex h-11 rounded-[12px] bg-neutral-3 p-[3px]"
      data-testid={testId}
    >
      {options.map((option, i) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${option.value}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${option.value}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={cx(
              "selis-focus min-w-0 flex-1 truncate rounded-[9px] px-2 text-sm transition-colors duration-150 ease-standard",
              selected ? "bg-surface-raised font-semibold text-neutral-12 shadow-1" : "font-medium text-neutral-11",
            )}
            data-testid={testId && `${testId}-${option.value}`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
