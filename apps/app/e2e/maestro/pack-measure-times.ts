/**
 * `node pack-measure-times.ts <.tmp/maestro/.maestro/tests>`: the import and export times of the
 * newest pack-measure.yaml run, from Maestro's commands.json (start timestamp + duration per
 * command). Each time runs from the start of the tap that starts the work ("Open", "Create file")
 * to the end of the wait labelled "TIMED …": an upper bound, too long by at most the tap's own
 * duration (Maestro finds the element, taps, then waits for the screen to settle).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

type Command = {
  command: Record<string, { label?: string; selector?: { textRegex?: string } } | undefined>;
  metadata: { status: string; timestamp: number; duration: number };
};

const root = process.argv[2];
if (!root) throw new Error("usage: pack-measure-times.ts <.tmp/maestro/.maestro/tests>");
const flow = "Selis pack timing (passphrase, 50 documents)";
const runs = readdirSync(root)
  .map((d) => join(root, d, flow, "commands.json"))
  .filter((f) => existsSync(f))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
const newest = runs[0];
if (newest === undefined) throw new Error(`no "${flow}" run under ${root}`);
const commands = JSON.parse(readFileSync(newest, "utf8")) as Command[];

const end = (c: Command): number => c.metadata.timestamp + c.metadata.duration;
const label = (c: Command): string | undefined => Object.values(c.command)[0]?.label;
const tapText = (c: Command): string | undefined => c.command.tapOnElement?.selector?.textRegex;

const rows: string[] = [];
for (const [name, tap] of [
  ["import", "Open"],
  ["export", "Create file"],
] as const) {
  const i = commands.findIndex((c) => label(c) === `TIMED ${name}`);
  const timed = commands[i];
  if (timed === undefined || timed.metadata.status !== "COMPLETED") throw new Error(`TIMED ${name} did not complete`);
  const tapped = commands.slice(0, i).findLast((c) => tapText(c) === tap);
  if (tapped === undefined) throw new Error(`no tap on "${tap}" before TIMED ${name}`);
  const seconds = (end(timed) - tapped.metadata.timestamp) / 1000;
  rows.push(`${name}: ≤ ${seconds.toFixed(1)} s (of which the tap on "${tap}" took ${(tapped.metadata.duration / 1000).toFixed(1)} s)`);
}
console.log(`${newest}\n${rows.join("\n")}`);
