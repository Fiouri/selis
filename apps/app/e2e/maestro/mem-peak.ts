/**
 * Memory around one step of a flow: `node mem-peak.ts <mem.log> <maestro tests dir> <flow name> <label>`.
 * mem.log comes from mem-sampler.ts; Maestro's commands.json gives when the step before the
 * labelled wait was done and when the wait ended. Prints app + renderer PSS (the project's gate,
 * docs/spike-p0.md) and RSS: the median of the 5 s before, the peak from the step until 1 s after,
 * and the share the renderer had at the peak.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

type Command = { command: Record<string, { label?: string } | undefined>; metadata: { timestamp: number; duration: number } };

const [log, root, flow, stepLabel] = process.argv.slice(2);
if (!log || !root || !flow || !stepLabel) throw new Error("usage: mem-peak.ts <mem.log> <tests dir> <flow name> <label>");
const newest = readdirSync(root)
  .map((d) => join(root, d, flow, "commands.json"))
  .filter((f) => existsSync(f))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
if (newest === undefined) throw new Error(`no "${flow}" run under ${root}`);
const commands = JSON.parse(readFileSync(newest, "utf8")) as Command[];
const at = commands.findIndex((c) => Object.values(c.command)[0]?.label === stepLabel);
const wait = commands[at];
const tap = commands[at - 1];
if (wait === undefined || tap === undefined) throw new Error(`no step labelled ${stepLabel}`);
const start = tap.metadata.timestamp;
const end = wait.metadata.timestamp + wait.metadata.duration + 1_000;
type Sample = { t: number; pss: number; rendPss: number; rss: number };
const samples: Sample[] = readFileSync(log, "utf8")
  .split("\n")
  .map((l) => l.trim().split(/\s+/).map(Number))
  .filter((p) => p.length === 5 && p.every((n) => Number.isFinite(n)))
  .map(([t = 0, appPss = 0, rendPss = 0, appRss = 0, rendRss = 0]) => ({ t, pss: appPss + rendPss, rendPss, rss: appRss + rendRss }));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const before = samples.filter((s) => s.t >= start - 5_000 && s.t < start);
const during = samples.filter((s) => s.t >= start && s.t <= end);
const basePss = median(before.map((s) => s.pss));
const baseRss = median(before.map((s) => s.rss));
if (basePss === undefined || baseRss === undefined || during.length === 0) {
  throw new Error(`not enough samples (${String(before.length)} before, ${String(during.length)} during)`);
}
const peak = during.reduce((a, b) => (b.pss > a.pss ? b : a));
const peakRss = Math.max(...during.map((s) => s.rss));
const mb = (kb: number) => (kb / 1024).toFixed(0);
console.log(
  `PSS (app + renderer) before ${mb(basePss)} MB, peak during "${stepLabel}" ${mb(peak.pss)} MB (+${mb(peak.pss - basePss)}; renderer ${mb(peak.rendPss)}); ` +
    `RSS before ${mb(baseRss)} MB, peak ${mb(peakRss)} MB (${String(during.length)} samples)`,
);
