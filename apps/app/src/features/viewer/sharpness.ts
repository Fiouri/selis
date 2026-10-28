/**
 * Local-only sharpness diagnostics (ADR 0002 amendment): what each visible page is
 * drawn at, and how long after scrolling or zooming stops every visible page shows
 * full resolution. Logged to the console (logcat on Android) and readable over the
 * WebView DevTools by scripts/measure-sharpness.ts. Never sent anywhere.
 */
export type PageSharpness = {
  readonly page: number;
  /** The page box (CSS px) and the device pixel ratio it is drawn for. */
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly dpr: number;
  /** Full-resolution bitmap size (device px) and the tier cap it was planned under. */
  readonly deviceWidth: number;
  readonly deviceHeight: number;
  readonly maxBitmapPixels: number;
  /** The bitmap covering the whole page as drawn now (the base, when tiled). */
  readonly bitmapWidth: number;
  readonly bitmapHeight: number;
  readonly tiled: boolean;
  readonly tilesVisible: number;
  readonly tilesDrawn: number;
  /** Everything on screen is at full resolution. */
  readonly sharp: boolean;
  /** Times a low-resolution pass was replaced by full resolution. */
  readonly upgrades: number;
};

type Clock = () => number;

export class SharpnessTracker {
  private readonly pages = new Map<number, PageSharpness>();
  private readonly now: Clock;
  private motionAt = 0;
  private moving = false;
  private pending = false;
  private sharpAt = 0;
  /** Milliseconds from the end of each scroll / zoom until every visible page was sharp. */
  readonly samples: number[] = [];

  constructor(now: Clock = () => performance.now()) {
    this.now = now;
  }

  /** Scrolling or zooming (true) or the motion has stopped (false; last motion = stop time). */
  motion(moving: boolean): void {
    if (moving) {
      this.motionAt = this.now();
      this.pending = true;
    }
    this.moving = moving;
    this.record();
  }

  page(index: number, state: PageSharpness | null): void {
    const before = this.allSharp();
    if (state) this.pages.set(index, state);
    else this.pages.delete(index);
    if (!before && this.allSharp()) this.sharpAt = this.now();
    this.record();
  }

  snapshot(): PageSharpness[] {
    return [...this.pages.values()].sort((a, b) => a.page - b.page);
  }

  reset(): void {
    this.samples.length = 0;
  }

  private allSharp(): boolean {
    if (this.pages.size === 0) return false;
    for (const p of this.pages.values()) if (!p.sharp) return false;
    return true;
  }

  private record(): void {
    if (!this.pending || this.moving || !this.allSharp()) return;
    this.pending = false;
    const ms = Math.max(0, this.sharpAt - this.motionAt);
    this.samples.push(ms);
    const pages = this.snapshot()
      .map(
        (p) =>
          `${String(p.page + 1)}:css=${p.cssWidth.toFixed(2)}x${p.cssHeight.toFixed(2)},dpr=${String(p.dpr)},` +
          `bitmap=${String(p.bitmapWidth)}x${String(p.bitmapHeight)},full=${String(p.deviceWidth)}x${String(p.deviceHeight)},` +
          `cap=${String(p.maxBitmapPixels)},tiles=${String(p.tilesDrawn)}/${String(p.tilesVisible)},upgrades=${String(p.upgrades)}`,
      )
      .join(" ");
    console.info(`[selis:perf] sharp-after-stop=${String(Math.round(ms))}ms ${pages}`);
  }
}

export const sharpness = new SharpnessTracker();
(window as unknown as { __selisSharpness?: SharpnessTracker }).__selisSharpness = sharpness;
