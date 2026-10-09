import { useId, type KeyboardEvent } from "react";
import { cx } from "./cx";

export type SegmentedOption<T extends string> = { value: T; label: string };

export type SegmentedControlProps<T extends string> = {
  label: string;
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (value: T) => void;
  testId?: string;
};

/** Four long (e.g. Greek) labels don't fit one row on a phone: use a balanced 2×2 grid there. */
function columns(count: number): string {
  if (count <= 1) return "grid-cols-1";
  if (count === 2) return "grid-cols-2";
  if (count === 3) return "grid-cols-3";
  return "grid-cols-2 min-[480px]:grid-cols-4";
}

const NEXT_KEYS = new Set(["ArrowRight", "ArrowDown"]);
const PREV_KEYS = new Set(["ArrowLeft", "ArrowUp"]);

/** Accessible single-choice control (radiogroup semantics, roving focus). */
export function SegmentedControl<T extends string>({ label, value, options, onChange, testId }: SegmentedControlProps<T>) {
  const labelId = `${useId()}-label`;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = NEXT_KEYS.has(event.key) ? 1 : PREV_KEYS.has(event.key) ? -1 : 0;
    if (step === 0 || options.length === 0) return;
    event.preventDefault();
    const index = options.findIndex((o) => o.value === value);
    const next = options[(index + step + options.length) % options.length];
    if (!next) return;
    onChange(next.value);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-value="${next.value}"]`)?.focus();
  };

  return (
    <div className="flex flex-col gap-2">
      <span id={labelId} className="text-sm font-medium text-neutral-11">
        {label}
      </span>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        data-testid={testId}
        onKeyDown={onKeyDown}
        className={cx("grid gap-1 rounded-control bg-neutral-3 p-1", columns(options.length))}
      >
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              data-value={option.value}
              onClick={() => onChange(option.value)}
              className={cx(
                "selis-focus min-h-11 rounded-[6px] px-2 text-sm font-medium transition-colors duration-150 ease-standard",
                selected ? "bg-accent-9 text-accent-contrast shadow-1" : "text-neutral-11 hover:bg-neutral-4 hover:text-neutral-12",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
