import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLongPress } from "./useLongPress";

const LABEL = "target";

function Target({ onLongPress, onClick }: { onLongPress: () => void; onClick: () => void }) {
  const press = useLongPress(onLongPress);
  return (
    <button type="button" aria-label={LABEL} {...press} onClick={onClick} />
  );
}

function setup() {
  const onLongPress = vi.fn();
  const onClick = vi.fn();
  const { getByRole } = render(<Target onLongPress={onLongPress} onClick={onClick} />);
  return { el: getByRole("button"), onLongPress, onClick };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useLongPress", () => {
  it("a touch long press opens once, even with the WebView's own contextmenu, and swallows the click", () => {
    const { el, onLongPress, onClick } = setup();
    fireEvent.pointerDown(el, { button: 0, clientX: 10, clientY: 10 });
    act(() => vi.advanceTimersByTime(500));
    fireEvent.contextMenu(el);
    fireEvent.pointerUp(el);
    fireEvent.click(el);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("every right click opens the menu, however soon after the last one", () => {
    const { el, onLongPress } = setup();
    for (let i = 0; i < 3; i++) {
      fireEvent.pointerDown(el, { button: 2 });
      fireEvent.contextMenu(el);
      fireEvent.pointerUp(el, { button: 2 });
      act(() => vi.advanceTimersByTime(100));
    }
    expect(onLongPress).toHaveBeenCalledTimes(3);
  });

  it("a short tap is a click, and moving turns the press into a scroll", () => {
    const { el, onLongPress, onClick } = setup();
    fireEvent.pointerDown(el, { button: 0, clientX: 10, clientY: 10 });
    act(() => vi.advanceTimersByTime(200));
    fireEvent.pointerUp(el);
    fireEvent.click(el);
    expect(onClick).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(el, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(el, { clientX: 10, clientY: 40 });
    act(() => vi.advanceTimersByTime(600));
    expect(onLongPress).not.toHaveBeenCalled();
  });
});
