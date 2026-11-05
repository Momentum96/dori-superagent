import { execFileSync } from "node:child_process";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { Reports, reportLine, isReportKind } from "../skills/dori-mode/scripts/src/reports.ts";
import { Telemetry, type MergeOutcome, type Usage } from "./telemetry.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../skills/dori-mode/scripts/src/config.ts";
import { deadPaneTick, newDeadPaneState, type DeadPaneState } from "../skills/dori-mode/scripts/src/dead-panes.ts";
import { claimDone, closeLane, type FlowDeps } from "../skills/dori-mode/scripts/src/done-flow.ts";
import { freshnessTick, heardAt } from "../skills/dori-mode/scripts/src/freshness.ts";
import { hcRunner } from "../skills/dori-mode/scripts/src/hc-runner.ts";
import { launchLane, LaunchError } from "../skills/dori-mode/scripts/src/launch.ts";
import { type Lane, type LaneStatus, Registry, statusOf } from "../skills/dori-mode/scripts/src/registry.ts";
import { realClock, run as spawnRun, type Runner } from "../skills/dori-mode/scripts/src/run.ts";
import { HerdrError, omoScreenIdle, shq, spawnExec, type AgentStatus, type Exec } from "./herdr.ts";
import { muxFor, type Mux } from "./mux.ts";
import { HcError } from "./hc.ts";
import { KEY_RE, reservedKey, Store, type HostLoad, type QueuedMessage, type Role } from "./store.ts";

// Lanes live in Dori mode's registry (<stateDir>/lanes): `dori start` is `dori launch` plus a [START] to the lead,
// `dori ready` is a done claim, `dori done` is a close. So sync, freshness, dead-panes, the thread hooks and the
// claim-done/watch flow see every lane, whichever command opened it.

export { KEY_RE, reservedKey };

const PROMPTS = join(import.meta.dir, "..", "prompts");
const CLI = resolve(import.meta.dir, "cli.ts");
export const REPORT_KINDS = ["milestone", "blocker", "question", "halted", "done"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
const LOST_FROM: ReadonlySet<LaneStatus> = new Set(["working", "not-done", "paused"]);

export type Deps = {
  readonly store: Store;
  readonly mux: Mux;
  readonly exec: Exec;
  readonly now: () => number;
  readonly agentCmd: string;
  readonly doriCmd: string;
  /** Dori mode's side: its config, lane registry, pane runner and clock. */
  readonly flow: FlowDeps;
  readonly host: () => HostLoad;
  readonly usage: Usage;
};

export const defaultDeps = async (): Promise<Deps> => {
  const config = await loadConfig();
  const store = new Store();
  const space = process.env["DORI_HC_SPACE"] ?? (config.laneWorkspace || undefined);
  const mux = muxFor(space ? { kind: config.mux, space } : { kind: config.mux });
  const cfg = process.env["DORI_CONFIG"] ? `DORI_CONFIG=${shq(process.env["DORI_CONFIG"])} ` : "";
  const session = process.env["DORI_HERDR_SESSION"];
  const herdrRun: Runner = session ? (argv, o) => spawnRun(argv[0] === "herdr" ? ["herdr", "--session", session, ...argv.slice(1)] : argv, o) : spawnRun;
  return {
    store,
    mux,
    exec: spawnExec,
    now: Date.now,
    agentCmd: process.env["DORI_AGENT_CMD"] ?? "omo",
    doriCmd: process.env["DORI_CMD"] ?? `DORI_HOME=${shq(store.root)} DORI_MUX=${mux.kind} ${cfg}bun ${shq(CLI)}`,
    flow: { run: config.mux === "hc" ? hcRunner(spawnRun) : herdrRun, clock: realClock, registry: new Registry(config.stateDir), config },
    host: () => ({ load1: loadavg()[0] ?? 0, cores: cpus().length, memFreePct: memFreePct() }),
    usage: new Telemetry(store.root),
  };
};

export class Refusal extends Error {}

const sysctlMemoryLevel = (): string => execFileSync("sysctl", ["-n", "kern.memorystatus_level"], { encoding: "utf8", timeout: 2000 });

/**
 * Percent of memory available to start new work. On Linux, os.freemem() is MemAvailable. On macOS it is only the
 * truly free pages (inactive and cached pages excluded), which sits near 0-5% on a healthy Mac, so the kernel's own
 * available-memory level (the figure behind Activity Monitor's memory pressure) is used there instead.
 */
export function memFreePct(
  platform: string = process.platform,
  readLevel: () => string = sysctlMemoryLevel,
  freePct: () => number = () => Math.round((freemem() / totalmem()) * 100),
): number {
  if (platform === "darwin") {
    try {
      const level = Number(readLevel().trim());
      if (Number.isFinite(level) && level >= 0 && level <= 100) return Math.round(level);
    } catch {
      // fall through to freemem(): a missing sysctl must not stop the loop from reading memory at all
    }
  }
  return freePct();
}

const prompt = (name: string, vars: Record<string, string>): string =>
  readFileSync(join(PROMPTS, name), "utf8").replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? `{{${k}}}`);

export function renderPrompt(d: Deps, name: string): string {
  const dir = join(d.store.root, "prompts");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, name);
  writeFileSync(out, prompt(name, { dori: d.doriCmd }));
  return out;
}

// ---------- roles and pane messaging ----------

/** The lead is the Dori-mode lead (config `leadPane`) unless `dori role lead` registered another pane. */
export const leadPane = (d: Deps): string | undefined => d.store.roles().lead ?? (d.flow.config.leadPane || undefined);

export async function resolveTarget(d: Deps, target: string): Promise<string> {
  if (d.mux.isPaneId(target)) return target;
  if (target === "lead") {
    const pane = leadPane(d);
    if (!pane) throw new Refusal("no lead pane: set leadPane in the config, or run dori role lead <pane>");
    return pane;
  }
  if (target === "duty") {
    const pane = d.store.roles().duty;
    if (!pane) throw new Refusal("no duty pane registered (dori up)");
    return pane;
  }
  const lane = await d.flow.registry.read(target);
  if (lane && statusOf(lane) !== "closed" && lane.pane) return lane.pane;
  throw new Refusal(`unknown target ${target}: not a pane id, role or open lane`);
}

/** Delivers now when the pane can read; otherwise queues it for the duty loop (busy agents are never interrupted). */
export type SendOptions = { readonly at?: number; readonly lane?: string };

export async function send(d: Deps, target: string, text: string, from: string, opts: SendOptions = {}): Promise<"DELIVERED" | "QUEUED"> {
  const paneId = await resolveTarget(d, target);
  d.store.enqueue(paneId, { at: opts.at ?? d.now(), from, text, ...(opts.lane ? { lane: opts.lane } : {}) });
  return (await flushInbox(d, paneId)) === "delivered" ? "DELIVERED" : "QUEUED";
}

const stillWorking = async (d: Deps, key: string): Promise<boolean> => {
  const lane = await d.flow.registry.read(key);
  return !!lane && statusOf(lane) === "working";
};

export async function flushInbox(d: Deps, paneId: string): Promise<"delivered" | "queued" | "no-agent"> {
  const read = d.store.queued(paneId);
  if (read.length === 0) return "delivered";
  // An [ESCALATE] queued while the lead was busy is stale once its lane claimed done or closed.
  const stale: QueuedMessage[] = [];
  for (const m of read) if (m.lane && !(await stillWorking(d, m.lane))) stale.push(m);
  if (stale.length > 0) d.store.dequeue(paneId, stale);
  // Oldest first by time stamp: a [START] carries its lane's open time, so a report sent while the lane was starting follows it.
  const queued = read.filter((m) => !stale.includes(m)).sort((a, b) => a.at - b.at);
  if (queued.length === 0) return "delivered";
  let status = await d.mux.status(paneId);
  if (d.mux.kind === "herdr" && status === "working") {
    try { if (omoScreenIdle(await d.mux.read(paneId, 30))) status = "idle"; } catch { /* Doubt keeps mail queued. */ }
  }
  if (status === "gone") throw new Refusal(`pane ${paneId} is gone; ${queued.length} message(s) kept in its inbox`);
  if (status === "shell") return "no-agent";
  if (!d.mux.canReceive(status)) return "queued";
  const body =
    queued.length === 1
      ? queued[0]!.text
      : `${queued.length} messages arrived while you were busy:\n\n` +
        queued.map((m, i) => `(${i + 1}) from ${m.from}:\n${m.text}`).join("\n\n");
  if (!(await d.mux.deliver(paneId, body, status))) return "no-agent";
  d.store.dequeue(paneId, queued);
  return "delivered";
}

export async function sendToShell(d: Deps, target: string, text: string, from: string): Promise<"DELIVERED" | "QUEUED"> {
  if (d.mux.kind === "hc") throw new Refusal("--to-shell is not supported on hc");
  const paneId = await resolveTarget(d, target);
  if ((await d.mux.status(paneId)) !== "shell") return send(d, target, text, from);
  if (await d.mux.typeIntoShell(paneId, text)) return "DELIVERED";
  d.store.enqueue(paneId, { at: d.now(), from, text });
  return "QUEUED";
}

async function tell(d: Deps, target: "lead" | "duty", text: string, from: string, opts: SendOptions = {}): Promise<void> {
  try {
    await send(d, target, text, from, opts);
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    process.stderr.write(`dori: ${e.message}; message kept: ${text.slice(0, 120)}\n`);
  }
}

export const tellLead = (d: Deps, text: string, from: string, opts: SendOptions = {}) => tell(d, "lead", text, from, opts);
const tellDuty = (d: Deps, text: string, from: string) => (d.store.roles().duty ? tell(d, "duty", text, from) : tellLead(d, text, from));

// ---------- lanes (Dori mode's registry) ----------

export type StartInput = { readonly title?: string; readonly done: string; readonly thread?: string; readonly cwd?: string; readonly model?: string };

export async function startLane(d: Deps, key: string, briefFile: string, opts: StartInput): Promise<{ lane: Lane; startup: string }> {
  const reserved = reservedKey(key);
  if (reserved) throw new Refusal(reserved);
  let r: { readonly lane: Lane; readonly startup: string };
  try {
    r = await launchLane(d.flow, { key, title: opts.title ?? key, brief: resolve(briefFile), done: opts.done, thread: opts.thread, model: opts.model, cwd: opts.cwd ? resolve(opts.cwd) : undefined });
  } catch (e) {
    if (e instanceof LaunchError) throw new Refusal(e.message);
    throw e;
  }
  // Stamped with the open time: the lane may report during the startup check, before this line is sent.
  await tellLead(d, `[START ${key}] lane opened in ${r.lane.pane ?? "?"}: ${r.startup}`, key, { at: Date.parse(r.lane.openedAt) });
  d.usage.record({ name: "dori.lane_started", open_lanes: Math.min((await d.flow.registry.open()).length, 1000) });
  return r;
}

async function openLane(d: Deps, key: string): Promise<Lane> {
  const lane = await d.flow.registry.read(key);
  if (!lane) throw new Refusal(`no lane ${key}`);
  if (statusOf(lane) === "closed") throw new Refusal(`lane ${key} is closed`);
  return lane;
}

/** Appends to the shared journal (freshness reads its quiet clock) and tells the lead. */
export async function report(d: Deps, key: string, text: string, kind: string = "milestone"): Promise<string> {
  if (!isReportKind(kind)) throw new Refusal(`--kind must be one of ${REPORT_KINDS.join(", ")}`);
  if (!text.trim()) throw new Refusal("a report needs text");
  await openLane(d, key);
  const line = reportLine(new Reports(d.flow.config.stateDir).report(key, kind, text, d.now()));
  await tellLead(d, line, key);
  return line;
}

/** READY is a done claim carrying the final answer: the watcher re-checks the lane's Done signals and closes it. */
export async function ready(d: Deps, key: string, text: string, evidence: readonly string[]): Promise<string> {
  if (evidence.length === 0) throw new Refusal("READY needs at least one --evidence link (a PR, a receipt, a file)");
  if (!text.trim()) throw new Refusal("READY needs the final answer text");
  const lane = await openLane(d, key);
  const claimed = await claimDone(d.flow, lane, `${text} | evidence: ${evidence.join(" ")}`);
  await tellLead(d, `[READY ${key}] ${text}\nevidence: ${evidence.join(" ")}`, key);
  d.usage.record({ name: "dori.lane_ready", evidence_count: Math.min(evidence.length, 100), lane_minutes: Math.min(Math.floor((d.now() - Date.parse(lane.openedAt)) / 60_000), 10_080) });
  return claimed;
}

/** The lead closes a lane now; Dori mode's close refuses unless every Done signal reads back live. */
export async function done(d: Deps, key: string): Promise<string[]> {
  const lane = await openLane(d, key);
  if (lane.pane) {
    const st = await d.mux.status(lane.pane);
    if (st === "working" || st === "blocked") throw new Refusal(`lane ${key} pane is ${st}; let it finish first`);
  }
  const r = await closeLane(d.flow, lane, "closed by the lead");
  if (!r.closed) throw new Refusal(r.lines.join("\n"));
  return r.lines;
}

// ---------- duty session, duty loop, liveness ----------

/** A short one-line reason. A HerdrError message carries the whole argv (the queued text), so use herdr's own output. */
function failureDetail(e: unknown): string {
  const raw = e instanceof HerdrError || e instanceof HcError ? e.result.stderr || e.result.stdout : e instanceof Error ? e.message : String(e);
  const first = raw.trim().split("\n")[0] ?? "";
  return first.length > 200 ? `${first.slice(0, 200)}...` : first;
}

export type DutyEvent = { lane?: string; pane?: string; action: string; detail?: string };
export type DutyMemory = { readonly deadSeen: Set<string>; readonly panes: DeadPaneState; readonly home: string; readonly intervalMs: number };
export const newDutyMemory = (intervalMs = 60_000, home = process.env["HOME"] ?? ""): DutyMemory => ({ deadSeen: new Set(), panes: newDeadPaneState(), home, intervalMs });

/**
 * One duty pass. The duty loop owns every lane sweep: inbox delivery, LOST, freshness (the only nudger) and dead panes,
 * plus one [ESCALATE] to the lead for a nudge a lane never answered. Each step fails alone, and the heartbeat is
 * written last on every pass, so `dori duty-watch` and `dori up` can tell a live loop from a dead one.
 */
export async function dutyTick(d: Deps, mem: DutyMemory = newDutyMemory()): Promise<DutyEvent[]> {
  const stop = d.store.stop("duty");
  if (stop) {
    d.store.beat({ at: d.now(), pid: process.pid, intervalMs: mem.intervalMs });
    return [{ action: "stopped", detail: stop.reason }];
  }
  const events: DutyEvent[] = [];
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      events.push({ action: `error ${name}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) });
    }
  };
  await step("inbox", async () => {
    for (const paneId of d.store.inboxPanes()) {
      try {
        const result = await flushInbox(d, paneId);
        if (result === "delivered") events.push({ pane: paneId, action: "flushed" });
        if (result === "no-agent") events.push({ pane: paneId, action: "inbox-held", detail: `no agent in front; ${d.store.queued(paneId).length} message(s) kept` });
      } catch (e) {
        if (e instanceof Refusal) events.push({ pane: paneId, action: "inbox-target-gone" });
        else events.push({ pane: paneId, action: "flush-failed", detail: failureDetail(e) });
      }
    }
  });
  await step("lanes", async () => {
    for (const lane of await d.flow.registry.open()) {
      try {
      if (!lane.pane) continue;
      const now = d.now();
      if ((await d.mux.status(lane.pane)) === "gone") {
        if (lane.lostReportedAt || !LOST_FROM.has(statusOf(lane))) continue;
        await d.flow.registry.write({ ...lane, lostReportedAt: new Date(now).toISOString() });
        await tellLead(d, `[LOST ${lane.key}] pane ${lane.pane} is gone and the lane has no done claim`, "duty");
        events.push({ lane: lane.key, action: "lost" });
        continue;
      }
      const nudged = lane.lastNudgeAt ?? 0;
      const waitMs = d.flow.config.nudgeAfterMin * 60_000;
      if (statusOf(lane) !== "working" || nudged === 0 || now - nudged < waitMs || (lane.escalatedAt ?? 0) >= nudged) continue;
      const heard = await heardAt(d.flow, lane);
      if (nudged <= heard) continue;
      await d.flow.registry.write({ ...lane, escalatedAt: now });
      await tellLead(d, `[ESCALATE ${lane.key}] no report for ${Math.round((now - heard) / 60_000)} min, and none since the nudge ${Math.round((now - nudged) / 60_000)} min ago`, "duty", { lane: lane.key });
      events.push({ lane: lane.key, action: "escalated" });
      } catch (e) { events.push({ lane: lane.key, action: "lane-failed", detail: failureDetail(e) }); }
    }
  });
  await step("freshness", async () => {
    for (const lane of await d.flow.registry.open()) {
      // Keep the shared sweep and its single nudger, but scope failures to this lane.
      const registry = new Proxy(d.flow.registry, {
        get(target, key, receiver) {
          if (key === "open") return async () => [lane];
          const value = Reflect.get(target, key, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      try {
        for (const a of await freshnessTick({ ...d.flow, registry }, mem.home)) {
          events.push({ lane: a.lane, action: `freshness ${a.kind}` });
          if (a.kind === "working-while-paused") await tellLead(d, `[PAUSED-BUT-WORKING ${a.lane}] ${a.detail}`, "duty");
        }
      } catch (e) {
        events.push({ lane: lane.key, action: "lane-failed", detail: failureDetail(e) });
      }
    }
  });
  await step("dead-panes", async () => {
    const roles = d.store.roles();
    const config = { ...d.flow.config, ignorePanes: [...d.flow.config.ignorePanes, ...[roles.duty, roles["duty-loop"], roles["hourly-loop"]].filter((p): p is string => !!p)] };
    for (const line of await deadPaneTick(d.flow.run, config, mem.deadSeen, new Date(d.now()).toISOString().slice(0, 13), mem.panes)) {
      const [kind = "", pane = ""] = line.split(" ");
      events.push({ pane, action: kind.toLowerCase() });
      await tellDuty(d, `[${kind} ${pane}] ${line}. Read its screen; restart the lane or tell the lead.`, "duty-loop");
    }
  });
  d.store.beat({ at: d.now(), pid: process.pid, intervalMs: mem.intervalMs });
  const count = (action: string) => events.filter((e) => e.action === action).length;
  d.usage.touch();
  d.usage.duty({ ticks: 1, flushed: count("flushed"), nudges: count("freshness nudged"), escalations: count("escalated"), lost: count("lost") });
  return events;
}

/** First line of `<agent> --version` (omo prints its engine too), or undefined when it cannot be read. */
async function agentVersion(d: Deps): Promise<string | undefined> {
  const bin = d.agentCmd.trim().split(/\s+/)[0];
  if (!bin) return undefined;
  const r = await d.exec(bin, ["--version"]).catch((e: unknown) => ({ code: -1, stdout: "", stderr: String(e) }));
  return r.code === 0 ? r.stdout.trim().split("\n")[0] || undefined : undefined;
}

export type WatchState = { stale: boolean };

/** For the lead's persistent monitor: one DUTY_STALE when the loop stops beating, one DUTY_OK when it is back. */
export function dutyWatchTick(d: Deps, staleMs: number, state: WatchState): string | null {
  const beat = d.store.heartbeat();
  const age = beat ? d.now() - beat.at : Number.POSITIVE_INFINITY;
  if (age > staleMs) {
    if (state.stale) return null;
    state.stale = true;
    return `DUTY_STALE ${beat ? `last beat ${Math.round(age / 60_000)} min ago (pid ${beat.pid})` : "no heartbeat yet"}; run: dori up`;
  }
  if (!state.stale) return null;
  state.stale = false;
  return `DUTY_OK beat ${Math.round(age / 1000)} s ago`;
}

/**
 * Idempotent: safe to run every minute (ensure-lead.sh does). It never starts a second lead: a configured lead that is
 * gone is left to its own restarter. It starts the duty session when it is gone, restarts its agent when only a shell
 * is left, replaces an idle duty session that runs an older agent version than the installed one, and replaces the
 * duty loop when its heartbeat is older than three intervals.
 */
export async function up(d: Deps, cwd: string, intervalSec = 60): Promise<string[]> {
  const out: string[] = [];
  const env = { DORI_HOME: d.store.root, DORI_MUX: d.mux.kind };
  let workspace = d.mux.ownWorkspace();
  const lead = leadPane(d);
  if (!lead) {
    const made = await d.mux.createWorkspace("dori", cwd);
    await d.mux.run(made.paneId, `${d.agentCmd} --append-system-prompt ${shq(renderPrompt(d, "lead.md"))}`);
    d.store.setRole("lead", made.paneId);
    workspace = made.workspaceId || workspace;
    out.push(`LEAD started ${made.paneId}`);
  } else {
    const st = await d.mux.status(lead);
    out.push(st === "gone" ? `LEAD ${lead} is gone; not starting another lead (its own restarter brings it back)` : `LEAD ${lead} ${st}`);
  }
  const dutyCmd = `${d.agentCmd} --append-system-prompt ${shq(renderPrompt(d, "duty.md"))}`;
  const duty = d.store.roles().duty;
  let dutySt: AgentStatus = duty ? await d.mux.status(duty) : "gone";
  const version = await agentVersion(d);
  const ran = d.store.dutyAgent();
  const ranVersion = ran && ran.pane === duty ? ran.version : "an unrecorded version";
  // After an agent update the duty session keeps the old one until it restarts; replace it only while it is idle.
  const outdated = !!duty && dutySt !== "gone" && dutySt !== "shell" && !!version && ranVersion !== version;
  let replaced = "";
  if (outdated && (dutySt === "idle" || dutySt === "done")) {
    await d.mux.close(duty!);
    replaced = ` (replaced ${duty}: it ran ${ranVersion}, installed is ${version})`;
    dutySt = "gone";
  }
  if (dutySt === "gone") {
    const made = await d.mux.createTab("duty", cwd, workspace, env);
    await d.mux.run(made.paneId, dutyCmd);
    d.store.setRole("duty", made.paneId);
    if (version) d.store.setDutyAgent({ pane: made.paneId, version });
    out.push(`DUTY started ${made.paneId}${replaced}`);
  } else if (dutySt === "shell") {
    await d.mux.run(duty!, dutyCmd);
    if (version) d.store.setDutyAgent({ pane: duty!, version });
    out.push(`DUTY restarted in ${duty}`);
  } else if (outdated) out.push(`DUTY ${duty} ${dutySt}; it runs ${ranVersion}, installed is ${version}: replaced once it is idle`);
  else out.push(`DUTY ${duty} ${dutySt}${version ? "" : "; agent version unknown, update check skipped"}`);
  const hourly = d.store.roles()["hourly-loop"];
  if (!hourly || (await d.mux.status(hourly)) === "gone") {
    const made = await d.mux.createTab("hourly-loop", cwd, workspace, env);
    await d.mux.run(made.paneId, `${d.doriCmd} loop`);
    d.store.setRole("hourly-loop", made.paneId);
    out.push(`HOURLY started ${made.paneId}`);
  }
  const beat = d.store.heartbeat();
  if (beat && d.now() - beat.at < 3 * beat.intervalMs) {
    out.push(`LOOP alive, beat ${Math.round((d.now() - beat.at) / 1000)} s ago`);
    return out;
  }
  const old = d.store.roles()["duty-loop"];
  if (old && (await d.mux.status(old)) !== "gone") await d.mux.close(old);
  const made = await d.mux.createTab("duty-loop", cwd, workspace, env);
  await d.mux.run(made.paneId, `${d.doriCmd} duty --interval ${intervalSec}`);
  d.store.setRole("duty-loop", made.paneId);
  // A provisional beat: a second `dori up` before the loop's first pass must not replace it again.
  d.store.beat({ at: d.now(), pid: 0, intervalMs: intervalSec * 1000 });
  out.push(`LOOP started ${made.paneId}${old ? ` (replaced ${old})` : ""}`);
  return out;
}

// ---------- review + merge gate ----------

export type PrRef = { repo: string; number: number; id: string };

export function parsePr(s: string): PrRef {
  const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(s);
  if (!m) throw new Refusal(`PR must look like owner/repo#123, got ${s}`);
  return { repo: m[1]!, number: Number(m[2]), id: s };
}

async function gh(d: Deps, argv: readonly string[]): Promise<string> {
  const r = await d.exec("gh", argv);
  if (r.code !== 0) throw new Error(`gh ${argv.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

export async function headSha(d: Deps, pr: PrRef): Promise<string> {
  const out = JSON.parse(await gh(d, ["pr", "view", String(pr.number), "--repo", pr.repo, "--json", "headRefOid"]));
  return String(out.headRefOid);
}

/** Runs a fresh, non-interactive reviewer session pinned to the PR head and records its verdict as a receipt. */
export async function review(d: Deps, prId: string, model?: string): Promise<{ verdict: "CLEAR" | "BLOCK"; sha: string }> {
  const pr = parsePr(prId);
  const sha = await headSha(d, pr);
  const text = prompt("review.md", { pr: pr.id, repo: pr.repo, number: String(pr.number), sha });
  const argv = ["-p", "--no-session", ...(model ? ["--model", model] : []), text];
  const res = await d.exec(d.agentCmd, argv);
  if (res.code !== 0) throw new Error(`reviewer exited ${res.code}: ${res.stderr.trim()}`);
  const verdicts = [...res.stdout.matchAll(/^VERDICT:\s*(CLEAR|BLOCK)\b/gm)];
  const last = verdicts.at(-1);
  if (!last) throw new Error("reviewer printed no VERDICT line; no receipt written");
  const verdict = last[1] as "CLEAR" | "BLOCK";
  d.store.saveReceipt({ pr: pr.id, sha, verdict, model: model ?? "default", at: d.now(), summary: res.stdout.trim().slice(-4000) });
  d.usage.record({ name: "dori.review_completed", verdict });
  return { verdict, sha };
}

type Check = { name: string; bucket: string };

/** Merge only when the exact current head has a CLEAR review receipt and every check passed. An empty check list is never green. */
export async function mergeGate(d: Deps, prId: string, opts: { dryRun?: boolean } = {}): Promise<string> {
  const pr = parsePr(prId);
  const sha = await headSha(d, pr);
  const refused = await gateRefusal(d, pr, sha);
  if (refused) {
    if (!opts.dryRun) d.usage.record({ name: "dori.merge_decided", outcome: refused[0] });
    throw new Refusal(`MERGE_REFUSED ${refused[1]}`);
  }
  if (opts.dryRun) return `MERGE_OK ${pr.id} head=${sha} (dry run)`;
  await gh(d, ["pr", "merge", String(pr.number), "--repo", pr.repo, "--squash", "--match-head-commit", sha]);
  d.usage.record({ name: "dori.merge_decided", outcome: "merged" });
  return `MERGED ${pr.id} head=${sha}`;
}

async function gateRefusal(d: Deps, pr: PrRef, sha: string): Promise<[MergeOutcome, string] | undefined> {
  const receipt = d.store.receipt(pr.id, sha);
  if (!receipt) return ["no_receipt", `no review receipt at head ${sha.slice(0, 12)} (run: dori review ${pr.id})`];
  if (receipt.verdict !== "CLEAR") return ["review_block", `review at ${sha.slice(0, 12)} is ${receipt.verdict}`];
  const checksRes = await d.exec("gh", ["pr", "checks", String(pr.number), "--repo", pr.repo, "--json", "name,bucket"]);
  const checks: Check[] = checksRes.stdout.trim().startsWith("[") ? JSON.parse(checksRes.stdout) : [];
  if (checks.length === 0) return ["no_checks", "no checks reported: an empty check list is never green"];
  const bad = checks.filter((c) => c.bucket !== "pass" && c.bucket !== "skipping");
  if (bad.length > 0) return ["checks_red", `checks not green: ${bad.map((c) => `${c.name}=${c.bucket}`).join(", ")}`];
  if (!checks.some((c) => c.bucket === "pass")) return ["checks_all_skipped", "every check was skipped"];
  return undefined;
}

export const ROLES: readonly Role[] = ["lead", "duty"];
