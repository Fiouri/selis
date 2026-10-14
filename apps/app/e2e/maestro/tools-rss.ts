/**
 * RSS around one step of a flow: `node tools-rss.ts <rss.log> <maestro tests dir> [flow name] [label]`
 * (default: the compress in tools.yaml, "Selis tools (qpdf)" / "RSS compress").
 * rss.log has "<epoch ms> <TOTAL RSS kB>" lines (tools.sh samples dumpsys meminfo); Maestro's
 * commands.json gives when "Make the file smaller" was tapped and when its result showed.
 * Prints the RSS just before (median of the 5 s before the tap), the peak from the tap until 1 s
 * after the result (samples come every ~0.7 s; the S23 compresses the fixture faster) and the
 * difference.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

type Command = { command: Record<string, { label?: string } | undefined>; metadata: { timestamp: number; duration: number } };

const [log, root, flowArg, labelArg] = process.argv.slice(2);
if (!log || !root) throw new Error("usage: tools-rss.ts <rss.log> <.tmp/maestro/.maestro/tests> [flow name] [label]");
const flow = flowArg ?? "Selis tools (qpdf)";
const stepLabel = labelArg ?? "RSS compress";
const newest = readdirSync(root)
  .map((d) => join(root, d, flow, "commands.json"))
  .filter((f) => existsSync(f))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
if (newest === undefined) throw new Error(`no "${flow}" run under ${root}`);
const commands = JSON.parse(readFileSync(newest, "utf8")) as Command[];
const label = (c: Command) => Object.values(c.command)[0]?.label;
const at = commands.findIndex((c) => label(c) === stepLabel);
const wait = commands[at];
const tap = commands[at - 1];
if (wait === undefined || tap === undefined) throw new Error(`no step labelled ${stepLabel}`);
const start = tap.metadata.timestamp;
const end = wait.metadata.timestamp + wait.metadata.duration + 1_000;
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
console.log(`RSS before ${mb(base)} MB, peak during "${stepLabel}" ${mb(peak)} MB, +${mb(peak - base)} MB (${String(during.length)} samples)`);
