/**
 * RSS around the compress in tools.yaml: `node tools-rss.ts <rss.log> <maestro tests dir>`.
 * rss.log has "<epoch ms> <TOTAL RSS kB>" lines (tools.sh samples dumpsys meminfo); Maestro's
 * commands.json gives when "Make the file smaller" was tapped and when its result showed.
 * Prints the RSS just before (median of the 5 s before the tap), the peak until the result and
 * the difference.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

type Command = { command: Record<string, { label?: string } | undefined>; metadata: { timestamp: number; duration: number } };

const [log, root] = process.argv.slice(2);
if (!log || !root) throw new Error("usage: tools-rss.ts <rss.log> <.tmp/maestro/.maestro/tests>");
const flow = "Selis tools (qpdf)";
const newest = readdirSync(root)
  .map((d) => join(root, d, flow, "commands.json"))
  .filter((f) => existsSync(f))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
if (newest === undefined) throw new Error(`no "${flow}" run under ${root}`);
const commands = JSON.parse(readFileSync(newest, "utf8")) as Command[];
const label = (c: Command) => Object.values(c.command)[0]?.label;
const compress = commands.find((c) => label(c) === "RSS compress");
if (compress === undefined) throw new Error("no step labelled RSS compress");
const start = compress.metadata.timestamp;
const end = start + compress.metadata.duration;
const samples = readFileSync(log, "utf8")
  .split("\n")
  .map((l) => l.trim().split(/\s+/).map(Number))
  .filter((p): p is [number, number] => p.length === 2 && p.every((n) => Number.isFinite(n)));
const before = samples.filter(([t]) => t >= start - 5_000 && t < start).map(([, kb]) => kb).sort((a, b) => a - b);
const during = samples.filter(([t]) => t >= start && t <= end).map(([, kb]) => kb);
const base = before[Math.floor(before.length / 2)];
if (base === undefined || during.length === 0) throw new Error(`not enough samples (${String(before.length)} before, ${String(during.length)} during)`);
const peak = Math.max(...during);
const mb = (kb: number) => (kb / 1024).toFixed(0);
console.log(`RSS before ${mb(base)} MB, peak while compressing ${mb(peak)} MB, +${mb(peak - base)} MB (${String(during.length)} samples)`);
