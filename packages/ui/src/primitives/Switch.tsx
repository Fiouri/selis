import { cx } from "./cx";

export type SwitchProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /**
   * The visible label's text, the accessible name, as visually hidden content of the button.
   * Not aria-labelledby: Chrome on Android does not hand a labelledby name to TalkBack ("Off,
   * Switch"; P5b walkthrough). Not aria-label either: Maestro would take it as the element's id
   * instead of data-testid.
   */
  label: string;
  describedBy?: string | undefined;
  disabled?: boolean;
  testId?: string | undefined;
};

/**
 * On/off switch: 48×28 track (on = accent, off = control-line), 22 px white knob,
 * 200 ms, inside a 52×44 button with role="switch".
 */
export function Switch({ checked, onChange, label, describedBy, disabled = false, testId }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-describedby={describedBy}
      disabled={disabled}
      data-testid={testId}
      onClick={() => onChange(!checked)}
      className="selis-focus inline-flex h-11 w-13 shrink-0 items-center justify-center rounded-full disabled:cursor-not-allowed disabled:opacity-45"
    >
      <span className="sr-only">{label}</span>
      <span
        aria-hidden="true"
        className={cx(
          "relative h-7 w-12 rounded-full transition-colors duration-200 ease-standard",
          checked ? "bg-accent-9" : "bg-control-line",
        )}
      >
        <span
          className="absolute top-[3px] left-0 size-[22px] rounded-full bg-white shadow-1 transition-transform duration-200 ease-standard"
          style={{ transform: checked ? "translateX(23px)" : "translateX(3px)" }}
        />
      </span>
    </button>
  );
}
