import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../skills/dori-mode/scripts/src/config.ts";
import { deadPaneTick, newDeadPaneState, type DeadPaneState } from "../skills/dori-mode/scripts/src/dead-panes.ts";
import { claimDone, closeLane, type FlowDeps } from "../skills/dori-mode/scripts/src/done-flow.ts";
import { freshnessTick } from "../skills/dori-mode/scripts/src/freshness.ts";
import { hcRunner } from "../skills/dori-mode/scripts/src/hc-runner.ts";
import { launchLane, LaunchError } from "../skills/dori-mode/scripts/src/launch.ts";
import { type Lane, type LaneStatus, Registry, statusOf } from "../skills/dori-mode/scripts/src/registry.ts";
import { realClock, run as spawnRun, type Runner } from "../skills/dori-mode/scripts/src/run.ts";
import { shq, spawnExec, type AgentStatus, type Exec } from "./herdr.ts";
import { muxFor, type Mux } from "./mux.ts";
import { Store, type Role } from "./store.ts";

// Lanes live in Dori mode's registry (<stateDir>/lanes): `dori start` is `dori launch` plus a [START] to the lead,
// `dori ready` is a done claim, `dori done` is a close. So sync, freshness, dead-panes, the thread hooks and the
// claim-done/watch flow see every lane, whichever command opened it.

const PROMPTS = join(import.meta.dir, "..", "prompts");
const CLI = resolve(import.meta.dir, "cli.ts");
export const REPORT_KINDS = ["milestone", "blocker", "question", "done"] as const;
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
  };
};

export class Refusal extends Error {}

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
export async function send(d: Deps, target: string, text: string, from: string): Promise<"DELIVERED" | "QUEUED"> {
  const paneId = await resolveTarget(d, target);
  d.store.enqueue(paneId, { at: d.now(), from, text });
  return (await flushInbox(d, paneId)) ? "DELIVERED" : "QUEUED";
}

export async function flushInbox(d: Deps, paneId: string): Promise<boolean> {
  const queued = d.store.queued(paneId);
  if (queued.length === 0) return true;
  const status = await d.mux.status(paneId);
  if (status === "gone") throw new Refusal(`pane ${paneId} is gone; ${queued.length} message(s) kept in its inbox`);
  if (!d.mux.canReceive(status)) return false;
  const body =
    queued.length === 1
      ? queued[0]!.text
      : `${queued.length} messages arrived while you were busy:\n\n` +
        queued.map((m, i) => `(${i + 1}) from ${m.from}:\n${m.text}`).join("\n\n");
  await d.mux.deliver(paneId, body, status);
  d.store.clearInbox(paneId);
  return true;
}

async function tell(d: Deps, target: "lead" | "duty", text: string, from: string): Promise<void> {
  try {
    await send(d, target, text, from);
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    process.stderr.write(`dori: ${e.message}; message kept: ${text.slice(0, 120)}\n`);
  }
}

const tellLead = (d: Deps, text: string, from: string) => tell(d, "lead", text, from);
const tellDuty = (d: Deps, text: string, from: string) => (d.store.roles().duty ? tell(d, "duty", text, from) : tellLead(d, text, from));

// ---------- lanes (Dori mode's registry) ----------

export type StartInput = { readonly title?: string; readonly done: string; readonly thread?: string; readonly cwd?: string; readonly model?: string };

export async function startLane(d: Deps, key: string, briefFile: string, opts: StartInput): Promise<{ lane: Lane; startup: string }> {
  let r: { readonly lane: Lane; readonly startup: string };
  try {
    r = await launchLane(d.flow, { key, title: opts.title ?? key, brief: resolve(briefFile), done: opts.done, thread: opts.thread, model: opts.model, cwd: opts.cwd ? resolve(opts.cwd) : undefined });
  } catch (e) {
    if (e instanceof LaunchError) throw new Refusal(e.message);
    throw e;
  }
  await tellLead(d, `[START ${key}] lane opened in ${r.lane.pane ?? "?"}: ${r.startup}`, key);
  return r;
}

async function openLane(d: Deps, key: string): Promise<Lane> {
  const lane = await d.flow.registry.read(key);
  if (!lane) throw new Refusal(`no lane ${key}`);
  if (statusOf(lane) === "closed") throw new Refusal(`lane ${key} is closed`);
  return lane;
}

/** Records the [REPORT] line on the lane (freshness posts the last one from there), resets its quiet clock, and tells the lead. */
export async function report(d: Deps, key: string, text: string, kind: string = "milestone"): Promise<string> {
  if (!(REPORT_KINDS as readonly string[]).includes(kind)) throw new Refusal(`--kind must be one of ${REPORT_KINDS.join(", ")}`);
  if (!text.trim()) throw new Refusal("a report needs text");
  const lane = await openLane(d, key);
  const line = `[REPORT] ${key} | ${kind} | ${text}`;
  await d.flow.registry.write({ ...lane, lastReplyAt: d.now(), lastReport: line });
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

export type DutyEvent = { lane?: string; pane?: string; action: string };
export type DutyMemory = { readonly deadSeen: Set<string>; readonly panes: DeadPaneState; readonly home: string; readonly intervalMs: number };
export const newDutyMemory = (intervalMs = 60_000, home = process.env["HOME"] ?? ""): DutyMemory => ({ deadSeen: new Set(), panes: newDeadPaneState(), home, intervalMs });

/**
 * One duty pass. The duty loop owns every lane sweep: inbox delivery, LOST, freshness (the only nudger) and dead panes,
 * plus one [ESCALATE] to the lead for a nudge a lane never answered. Each step fails alone, and the heartbeat is
 * written last on every pass, so `dori duty-watch` and `dori up` can tell a live loop from a dead one.
 */
export async function dutyTick(d: Deps, mem: DutyMemory = newDutyMemory()): Promise<DutyEvent[]> {
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
        if (await flushInbox(d, paneId)) events.push({ pane: paneId, action: "flushed" });
      } catch (e) {
        if (!(e instanceof Refusal)) throw e;
        events.push({ pane: paneId, action: "inbox-target-gone" });
      }
    }
  });
  await step("lanes", async () => {
    for (const lane of await d.flow.registry.open()) {
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
      const heard = lane.lastReplyAt ?? Date.parse(lane.openedAt);
      const waitMs = d.flow.config.nudgeAfterMin * 60_000;
      if (statusOf(lane) !== "working" || nudged <= heard || now - nudged < waitMs || (lane.escalatedAt ?? 0) >= nudged) continue;
      await d.flow.registry.write({ ...lane, escalatedAt: now });
      await tellLead(d, `[ESCALATE ${lane.key}] no report for ${Math.round((now - heard) / 60_000)} min, and none since the nudge ${Math.round((now - nudged) / 60_000)} min ago`, "duty");
      events.push({ lane: lane.key, action: "escalated" });
    }
  });
  await step("freshness", async () => {
    for (const a of await freshnessTick(d.flow, mem.home)) {
      events.push({ lane: a.lane, action: `freshness ${a.kind}` });
      if (a.kind === "working-while-paused") await tellLead(d, `[PAUSED-BUT-WORKING ${a.lane}] ${a.detail}`, "duty");
    }
  });
  await step("dead-panes", async () => {
    const roles = d.store.roles();
    const config = { ...d.flow.config, ignorePanes: [...d.flow.config.ignorePanes, ...[roles.duty, roles["duty-loop"]].filter((p): p is string => !!p)] };
    for (const line of await deadPaneTick(d.flow.run, config, mem.deadSeen, new Date(d.now()).toISOString().slice(0, 13), mem.panes)) {
      const [kind = "", pane = ""] = line.split(" ");
      events.push({ pane, action: kind.toLowerCase() });
      await tellDuty(d, `[${kind} ${pane}] ${line}. Read its screen; restart the lane or tell the lead.`, "duty-loop");
    }
  });
  d.store.beat({ at: d.now(), pid: process.pid, intervalMs: mem.intervalMs });
  return events;
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
 * is left, and replaces the duty loop when its heartbeat is older than three intervals.
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
  const dutySt: AgentStatus = duty ? await d.mux.status(duty) : "gone";
  if (dutySt === "gone") {
    const made = await d.mux.createTab("duty", cwd, workspace, env);
    await d.mux.run(made.paneId, dutyCmd);
    d.store.setRole("duty", made.paneId);
    out.push(`DUTY started ${made.paneId}`);
  } else if (dutySt === "shell") {
    await d.mux.run(duty!, dutyCmd);
    out.push(`DUTY restarted in ${duty}`);
  } else out.push(`DUTY ${duty} ${dutySt}`);
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
  return { verdict, sha };
}

type Check = { name: string; bucket: string };

/** Merge only when the exact current head has a CLEAR review receipt and every check passed. An empty check list is never green. */
export async function mergeGate(d: Deps, prId: string, opts: { dryRun?: boolean } = {}): Promise<string> {
  const pr = parsePr(prId);
  const sha = await headSha(d, pr);
  const receipt = d.store.receipt(pr.id, sha);
  if (!receipt) throw new Refusal(`MERGE_REFUSED no review receipt at head ${sha.slice(0, 12)} (run: dori review ${pr.id})`);
  if (receipt.verdict !== "CLEAR") throw new Refusal(`MERGE_REFUSED review at ${sha.slice(0, 12)} is ${receipt.verdict}`);
  const checksRes = await d.exec("gh", ["pr", "checks", String(pr.number), "--repo", pr.repo, "--json", "name,bucket"]);
  const checks: Check[] = checksRes.stdout.trim().startsWith("[") ? JSON.parse(checksRes.stdout) : [];
  if (checks.length === 0) throw new Refusal("MERGE_REFUSED no checks reported: an empty check list is never green");
  const bad = checks.filter((c) => c.bucket !== "pass" && c.bucket !== "skipping");
  if (bad.length > 0) throw new Refusal(`MERGE_REFUSED checks not green: ${bad.map((c) => `${c.name}=${c.bucket}`).join(", ")}`);
  if (!checks.some((c) => c.bucket === "pass")) throw new Refusal("MERGE_REFUSED every check was skipped");
  if (opts.dryRun) return `MERGE_OK ${pr.id} head=${sha} (dry run)`;
  await gh(d, ["pr", "merge", String(pr.number), "--repo", pr.repo, "--squash", "--match-head-commit", sha]);
  return `MERGED ${pr.id} head=${sha}`;
}

export const ROLES: readonly Role[] = ["lead", "duty"];
