import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { shq, spawnExec, type AgentStatus, type Exec } from "./herdr.ts";
import { muxFor, type Mux } from "./mux.ts";
import { Store, type Lane, type Role } from "./store.ts";

export const NUDGE_MINUTES = [10, 20, 40] as const;
const KEY_RE = /^[a-z][a-z0-9-]{1,40}$/;
const PROMPTS = join(import.meta.dir, "..", "prompts");
const CLI = resolve(import.meta.dir, "cli.ts");

export type Deps = {
  readonly store: Store;
  readonly mux: Mux;
  readonly exec: Exec;
  readonly now: () => number;
  readonly agentCmd: string;
  readonly doriCmd: string;
};

export const defaultDeps = (): Deps => {
  const store = new Store();
  const mux = muxFor();
  return {
    store,
    mux,
    exec: spawnExec,
    now: Date.now,
    agentCmd: process.env["DORI_AGENT_CMD"] ?? "omo",
    doriCmd: process.env["DORI_CMD"] ?? `DORI_HOME=${shq(store.root)} DORI_MUX=${mux.kind} bun ${shq(CLI)}`,
  };
};

export class Refusal extends Error {}

const prompt = (name: string, vars: Record<string, string>): string =>
  readFileSync(join(PROMPTS, name), "utf8").replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? `{{${k}}}`);

// ---------- pane messaging ----------

export function resolveTarget(d: Deps, target: string): string {
  if (d.mux.isPaneId(target)) return target;
  const roles = d.store.roles();
  if (target === "lead" || target === "duty") {
    const pane = roles[target];
    if (!pane) throw new Refusal(`no ${target} pane registered (dori role ${target} <pane>)`);
    return pane;
  }
  const lane = d.store.lane(target);
  if (lane && lane.status !== "done") return lane.paneId;
  throw new Refusal(`unknown target ${target}: not a pane id, role or open lane`);
}

const READY_TO_READ: readonly AgentStatus[] = ["idle", "done", "shell"];

/** Delivers now when the pane can read; otherwise queues it for the duty loop (busy agents are never interrupted). */
export async function send(d: Deps, target: string, text: string, from: string): Promise<"DELIVERED" | "QUEUED"> {
  const paneId = resolveTarget(d, target);
  d.store.enqueue(paneId, { at: d.now(), from, text });
  return (await flushInbox(d, paneId)) ? "DELIVERED" : "QUEUED";
}

export async function flushInbox(d: Deps, paneId: string): Promise<boolean> {
  const queued = d.store.queued(paneId);
  if (queued.length === 0) return true;
  const status = await d.mux.status(paneId);
  if (status === "gone") throw new Refusal(`pane ${paneId} is gone; ${queued.length} message(s) kept in its inbox`);
  if (!READY_TO_READ.includes(status)) return false;
  const body =
    queued.length === 1
      ? queued[0]!.text
      : `${queued.length} messages arrived while you were busy:\n\n` +
        queued.map((m, i) => `(${i + 1}) from ${m.from}:\n${m.text}`).join("\n\n");
  await d.mux.deliver(paneId, body, status);
  d.store.clearInbox(paneId);
  return true;
}

async function tellLead(d: Deps, text: string, from: string): Promise<void> {
  if (!d.store.roles().lead) {
    process.stderr.write(`dori: no lead pane registered; message kept only in the lane log\n`);
    return;
  }
  await send(d, "lead", text, from);
}

// ---------- lanes ----------

export async function startLane(
  d: Deps,
  key: string,
  briefFile: string,
  opts: { cwd?: string; workspace?: string } = {},
): Promise<Lane> {
  if (!KEY_RE.test(key)) throw new Refusal(`lane key must match ${KEY_RE}`);
  const existing = d.store.lane(key);
  if (existing && existing.status !== "done") throw new Refusal(`lane ${key} is already open in ${existing.paneId}`);
  const cwd = resolve(opts.cwd ?? process.cwd());
  const briefPath = d.store.briefPath(key);
  const footer = prompt("lane-footer.md", { key, dori: d.doriCmd });
  await Bun.write(briefPath, `${readFileSync(briefFile, "utf8").trimEnd()}\n\n${footer}`);

  const workspace = opts.workspace ?? d.mux.ownWorkspace();
  const env = { DORI_LANE: key, DORI_HOME: d.store.root, DORI_MUX: d.mux.kind };
  const pane = workspace !== undefined
    ? await d.mux.createTab(key, cwd, workspace, env)
    : await d.mux.createTab(key, cwd, (await d.mux.createWorkspace("dori", cwd)).workspaceId, env);
  const kickoff = `Read your brief at ${briefPath} and execute it. Your lane key is ${key}.`;
  await d.mux.run(pane.paneId, `${d.agentCmd} ${shq(kickoff)}`);

  const now = d.now();
  const lane: Lane = {
    key, paneId: pane.paneId, tabId: pane.tabId, brief: briefPath, cwd,
    status: "working", createdAt: now, lastActivityAt: now, nudges: 0,
    log: [{ at: now, kind: "start", text: briefFile }],
  };
  d.store.saveLane(lane);
  await tellLead(d, `[START ${key}] lane opened in ${pane.paneId}`, key);
  return lane;
}

function openLane(d: Deps, key: string): Lane {
  const lane = d.store.lane(key);
  if (!lane) throw new Refusal(`no lane ${key}`);
  if (lane.status === "done" || lane.status === "lost") throw new Refusal(`lane ${key} is ${lane.status}`);
  return lane;
}

export async function report(d: Deps, key: string, text: string, status?: "working" | "waiting"): Promise<void> {
  const lane = openLane(d, key);
  const now = d.now();
  lane.log.push({ at: now, kind: "report", text });
  lane.lastActivityAt = now;
  lane.nudges = 0;
  if (status) lane.status = status;
  d.store.saveLane(lane);
  await tellLead(d, `[REPORT ${key}${status === "waiting" ? " WAITING" : ""}] ${text}`, key);
}

export async function ready(d: Deps, key: string, text: string, evidence: readonly string[]): Promise<void> {
  if (evidence.length === 0) throw new Refusal("READY needs at least one --evidence link (a PR, a receipt, a file)");
  if (!text.trim()) throw new Refusal("READY needs the final answer text");
  const lane = openLane(d, key);
  const now = d.now();
  lane.status = "ready";
  lane.final = { text, evidence: [...evidence], at: now };
  lane.lastActivityAt = now;
  lane.log.push({ at: now, kind: "ready", text });
  d.store.saveLane(lane);
  await tellLead(d, `[READY ${key}] ${text}\nevidence: ${evidence.join(" ")}`, key);
}

export async function done(d: Deps, key: string): Promise<void> {
  const lane = d.store.lane(key);
  if (!lane) throw new Refusal(`no lane ${key}`);
  if (lane.status !== "ready") throw new Refusal(`lane ${key} is ${lane.status}, not ready: no final answer recorded`);
  const st = await d.mux.status(lane.paneId);
  if (st === "working" || st === "blocked") throw new Refusal(`lane ${key} pane is ${st}; let it finish first`);
  if (st !== "gone") await d.mux.close(lane.paneId);
  lane.status = "done";
  lane.log.push({ at: d.now(), kind: "done", text: "closed by lead" });
  d.store.saveLane(lane);
}

// ---------- duty loop ----------

export type DutyEvent = { lane?: string; pane?: string; action: string };

/** One proactive pass: flush inboxes of panes that became idle, nudge silent lanes, escalate, detect lost panes. */
export async function dutyTick(d: Deps): Promise<DutyEvent[]> {
  const events: DutyEvent[] = [];
  for (const paneId of d.store.inboxPanes()) {
    try {
      if (await flushInbox(d, paneId)) events.push({ pane: paneId, action: "flushed" });
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      events.push({ pane: paneId, action: "inbox-target-gone" });
    }
  }
  for (const lane of d.store.lanes()) {
    if (lane.status !== "working" && lane.status !== "waiting") continue;
    const st = await d.mux.status(lane.paneId);
    const now = d.now();
    if (st === "gone") {
      lane.status = "lost";
      lane.log.push({ at: now, kind: "lost", text: "pane disappeared without READY" });
      d.store.saveLane(lane);
      await tellLead(d, `[LOST ${lane.key}] pane ${lane.paneId} closed without a final answer`, "duty");
      events.push({ lane: lane.key, action: "lost" });
      continue;
    }
    if (st === "working") {
      lane.lastActivityAt = now;
      d.store.saveLane(lane);
      continue;
    }
    if (lane.status === "waiting" || st === "blocked") continue;
    const idleMin = (now - lane.lastActivityAt) / 60_000;
    const due = NUDGE_MINUTES[lane.nudges];
    if (due === undefined || idleMin < due) continue;
    lane.nudges += 1;
    lane.log.push({ at: now, kind: "nudge", text: `idle ${Math.floor(idleMin)} min` });
    d.store.saveLane(lane);
    if (lane.nudges < NUDGE_MINUTES.length) {
      await send(d, lane.key, prompt("nudge.md", { key: lane.key, minutes: String(Math.floor(idleMin)), dori: d.doriCmd }), "duty");
      events.push({ lane: lane.key, action: `nudge-${lane.nudges}` });
    } else {
      await tellLead(d, `[ESCALATE ${lane.key}] idle ${Math.floor(idleMin)} min with no READY after ${lane.nudges - 1} nudges`, "duty");
      events.push({ lane: lane.key, action: "escalated" });
    }
  }
  return events;
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
