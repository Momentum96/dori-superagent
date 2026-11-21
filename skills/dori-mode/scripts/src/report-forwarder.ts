/**
 * dori forward-reports: hands each lane's blocker, question, halted and done reports, and its stalled activity, to the
 * lead inbox, so a lane never names or calls the lead. Each journal line becomes one envelope whose id is
 * `r:<machine>:<laneKey>:<byteOffset>`; the inbox ignores an id it already holds, so a line sent twice (a crash after
 * delivery, a timeout after the far side stored it) is still one item. A file's cursor moves only past lines whose
 * delivery was acknowledged (see ACKS), and the lines of one file go strictly in order.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ConfigError, type DoriConfig } from "./config.ts";
import { LANE_KEY, type Registry } from "./registry.ts";
import { type LaneEvent, parseEvent, ReportError, reportLine } from "./reports.ts";
import type { Ran, Runner } from "./run.ts";

export type ForwarderDeps = {
  readonly run: Runner;
  readonly registry: Registry;
  readonly stateDir: string;
  readonly machine: string;
  /** Run once per envelope with the envelope as JSON on stdin; it must exit 0 and print an ACKS word last. */
  readonly inboxArgv: readonly string[];
};

export type ForwardAct = {
  readonly kind: "forwarded" | "failed" | "malformed" | "rewound";
  readonly lane: string;
  readonly detail: string;
};

// The far side may be an ssh hop whose remote command hangs; a delivery that runs out is a failure, retried later.
const DELIVERY_TIMEOUT_MS = 30_000;
// The last stdout line that proves the inbox holds the envelope: `spooled` from macmini's dori-inbox-drop, `inserted`
// or `duplicate` from `dori lead-inbox put`. The exit code alone is not proof: Tailscale SSH into macmini reports 0
// for every remote command, so a refused envelope or a missing entry command would read as delivered.
const ACKS: ReadonlySet<string> = new Set(["spooled", "inserted", "duplicate"]);
const acknowledged = (ran: Ran): boolean => ran.code === 0 && ACKS.has(ran.out.trim().split("\n").at(-1)?.trim() ?? "");
const NEWLINE = 0x0a;

/** A bot's lead inbox on this machine: the lead-inbox command of this same CLI, under the same DORI_CONFIG. */
export const localInboxArgv = (bot = "omo"): string[] => [
  process.execPath,
  fileURLToPath(new URL("./cli.ts", import.meta.url)),
  "lead-inbox",
  "put",
  "--bot",
  bot,
  "--envelope",
];

// The machine name goes into inbox item ids, so it is held to a plain lowercase word.
const MACHINE = /^[a-z][a-z0-9-]{0,31}$/;

export const forwarderDeps = (config: DoriConfig, run: Runner, registry: Registry): ForwarderDeps => {
  const machine: unknown = config.machine ?? (hostname().split(".")[0] ?? "").toLowerCase();
  if (typeof machine !== "string" || !MACHINE.test(machine))
    throw new ConfigError(
      `invalid machine ${JSON.stringify(machine)}: set "machine" in the config to a lowercase word`,
    );
  return { run, registry, stateDir: config.stateDir, machine, inboxArgv: config.leadInboxArgv ?? localInboxArgv() };
};

/** The inbox kind a journal record is forwarded as; null = it stays on the lane (milestones go to the thread). */
const forwardedKind = (event: LaneEvent): string | null => {
  switch (event.type) {
    case "report":
      return event.kind === "milestone" ? null : event.kind;
    case "activity":
      return event.state === "stalled" ? "stalled" : null;
  }
};

type Cursors = Record<string, number>;

class CursorFile {
  readonly path: string;
  constructor(stateDir: string) {
    this.path = join(stateDir, "forwarder", "cursors.json");
  }

  /** An unreadable file starts every journal over: a resent line carries its old id, so the inbox keeps one copy. */
  read(): { readonly cursors: Cursors; readonly problem?: string } {
    if (!existsSync(this.path)) return { cursors: {} };
    try {
      const value: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
      const cursors: Cursors = {};
      for (const [key, at] of Object.entries(value))
        if (typeof at === "number" && Number.isSafeInteger(at) && at >= 0) cursors[key] = at;
      return { cursors };
    } catch (e) {
      return { cursors: {}, problem: `${this.path}: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  write(cursors: Cursors): void {
    mkdirSync(join(this.path, ".."), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(cursors)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

const journalKeys = (stateDir: string): string[] => {
  const dir = join(stateDir, "lanes");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && LANE_KEY.test(d.name) && existsSync(join(dir, d.name, "reports.jsonl")))
    .map((d) => d.name)
    .sort();
};

type LaneRun = { readonly key: string; readonly thread: string; readonly cursor: number };

const forwardJournal = async (
  deps: ForwarderDeps,
  lane: LaneRun,
): Promise<{ readonly cursor: number; readonly acts: ForwardAct[] }> => {
  const bytes = readFileSync(join(deps.stateDir, "lanes", lane.key, "reports.jsonl"));
  const acts: ForwardAct[] = [];
  let at = lane.cursor;
  if (at > bytes.length) {
    // The journal is append-only, so a shorter file was replaced: read it from the start.
    acts.push({ kind: "rewound", lane: lane.key, detail: `journal is ${bytes.length} bytes, cursor was ${at}` });
    at = 0;
  }
  for (let end = bytes.indexOf(NEWLINE, at); end !== -1; end = bytes.indexOf(NEWLINE, at)) {
    // A line with no newline yet is still being written; it waits for the next tick.
    const line = bytes.subarray(at, end).toString("utf8");
    let event: LaneEvent | null = null;
    try {
      event = line.trim() ? parseEvent(line, lane.key) : null;
    } catch (e) {
      if (!(e instanceof SyntaxError || e instanceof ReportError)) throw e;
      acts.push({ kind: "malformed", lane: lane.key, detail: `byte ${at}: ${e.message}` });
    }
    const kind = event && forwardedKind(event);
    if (event && kind) {
      const id = `r:${deps.machine}:${lane.key}:${at}`;
      const envelope = {
        id,
        kind,
        source: `lane:${deps.machine}/${lane.key}`,
        body: `${reportLine({ key: lane.key, kind: event.type === "report" ? event.kind : "stalled", text: event.text })}\nmachine ${deps.machine} | thread ${lane.thread} | at ${event.at}`,
      };
      const ran = await deps.run(deps.inboxArgv, { stdin: JSON.stringify(envelope), timeoutMs: DELIVERY_TIMEOUT_MS });
      if (!acknowledged(ran)) {
        const said = `${ran.out} ${ran.err}`.replace(/\s+/g, " ").trim();
        acts.push({ kind: "failed", lane: lane.key, detail: `${id} exit ${ran.code} no ack: ${said}`.slice(0, 300) });
        return { cursor: at, acts };
      }
      acts.push({ kind: "forwarded", lane: lane.key, detail: `${id} ${kind}` });
    }
    at = end + 1;
  }
  return { cursor: at, acts };
};

/**
 * One pass over every lane journal on this machine. A journal whose delivery fails keeps its cursor at that line and
 * the pass goes on with the next journal. The cursor file is written only when a cursor moved past a delivered line or
 * a journal was read to its end, so a pass that delivers nothing new leaves it as it was.
 */
export const forwardTick = async (deps: ForwarderDeps): Promise<ForwardAct[]> => {
  const file = new CursorFile(deps.stateDir);
  const { cursors, problem } = file.read();
  const acts: ForwardAct[] = problem
    ? [{ kind: "rewound", lane: "-", detail: `cursor file unreadable: ${problem}` }]
    : [];
  let moved = problem !== undefined;
  for (const key of journalKeys(deps.stateDir)) {
    let thread: string;
    try {
      const lane = await deps.registry.read(key);
      // An adopted lane (no jsonl-v1 protocol) keeps the screen path; a journal with no lane record is not forwarded.
      if (lane?.reportProtocol !== "jsonl-v1") continue;
      thread = lane.thread;
    } catch (e) {
      acts.push({ kind: "failed", lane: key, detail: `lane record: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }
    const before = cursors[key] ?? 0;
    const result = await forwardJournal(deps, { key, thread, cursor: before });
    acts.push(...result.acts);
    const failed = result.acts.some((a) => a.kind === "failed");
    // A failed journal moves only past the lines delivered before the failure, never past skipped ones alone.
    const delivered = result.acts.some((a) => a.kind === "forwarded");
    if (result.cursor !== before && (!failed || delivered)) {
      cursors[key] = result.cursor;
      moved = true;
    }
  }
  if (moved) file.write(cursors);
  return acts;
};
