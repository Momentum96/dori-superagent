#!/usr/bin/env bun
import { resolve } from "node:path";
import {
  defaultDeps, done, dutyTick, dutyWatchTick, leadPane, mergeGate, newDutyMemory, ready, Refusal, report, review, send, sendToShell, startLane, up, ROLES, type Deps,
} from "./harness.ts";
import { statusOf } from "../skills/dori-mode/scripts/src/registry.ts";
import { backlogAdd, backlogDecide, backlogDrop, backlogImport, loopTick, msUntilNext, summary, HOUR, IMPORT_LIMIT } from "./loop.ts";
import type { Role } from "./store.ts";

import { Reports, reportLine } from "../skills/dori-mode/scripts/src/reports.ts";
import { main as skillMain } from "../skills/dori-mode/scripts/src/cli.ts";
const SKILL_COMMANDS: ReadonlySet<string> = new Set([
  "launch", "adopt", "sync", "claim-done", "object-done", "close", "pause", "resume", "watch", "freshness",
  "dead-panes", "guard", "heavy", "can-launch", "presence", "transcribe", "inbound", "boot", "checkpoint", "checkpoints", "lesson", "verify-pr", "worklog",
]);
const MESSENGERS: ReadonlySet<string> = new Set(["slack", "telegram", "discord"]);

/** Dori mode owns these commands; `send` is Dori mode's only when it names a messenger. */
export const isSkillCommand = (argv: readonly string[]): boolean => {
  const [cmd, x] = argv;
  if (cmd === undefined) return false;
  return SKILL_COMMANDS.has(cmd) || (cmd === "send" && x !== undefined && MESSENGERS.has(x));
};

const USAGE = `dori - a proactive multi-session harness on herdr (or hc) + omo

  dori up [--cwd DIR] [--interval SECONDS]    make sure lead, duty session, duty and hourly loops run; never starts a
                                              second lead (lead = roles.json or config leadPane). Safe every minute
  dori role <lead|duty> [PANE]                register a pane as lead or duty (default: this pane)
  dori start <key> --brief FILE --done "SIGNALS" [--title T] [--thread REF] [--cwd DIR] [--model M]
                                              open a lane (same as dori launch) and tell the lead
  dori report <key> --text T [--kind milestone|blocker|question|halted|done]
  dori ready <key> --text T --evidence LINK [--evidence LINK ...]   a done claim with the final answer
  dori send <lead|duty|key|pane> --text T     deliver now, or queue until the pane is an idle agent
                  [--to-shell]                explicit operator option for herdr only; hc refuses
  dori duty [--once] [--interval SECONDS]     inbox, LOST, freshness, dead panes, escalations; writes a heartbeat
  dori duty-watch [--loop MIN] [--stale-min N]  DUTY_STALE when the duty loop's heartbeat is older than N min
  dori duty stop [--text WHY] | resume | status   kill switch
  dori loop [--once] [--interval S] [--max-lanes N] [--max-starts N] [--max-load L] [--force]
                                              hourly: sync backlog, audit missed work, start the next item, ask decisions
  dori loop stop [--text WHY] | resume | status   kill switch and last run
  dori backlog add <id> --brief FILE --done SIGNALS [--title T] [--priority 1-9] [--cwd DIR] [--decision Q]
  dori backlog list | decide <id> --text ANSWER [--done SIGNALS] | drop <id> [--text WHY]
  dori backlog import <owner/repo> [--label dori] [--cwd DIR]   open labelled issues -> items
  dori review <owner/repo#N> [--model M]      fresh omo reviewer at the exact head -> receipt
  dori merge <owner/repo#N> [--dry-run]       CLEAR receipt at head + green checks -> squash merge
  dori done <key>                             close a lane now (its Done signals must read back live)
  dori status

--text may be omitted to read the message from stdin.
Multiplexer: DORI_MUX=herdr|hc, or "mux" in ~/.dori/config.json (default herdr).

Dori mode commands run the skill's CLI (skills/dori-mode/scripts, also installed as dori-mode):
  ${[...SKILL_COMMANDS].join(", ")}, send <slack|telegram|discord>. Run: dori-mode help`;

const COMMANDS = new Set(["up", "role", "start", "report", "ready", "send", "duty", "review", "merge", "done", "status", "loop", "backlog"]);

type Args = { pos: string[]; flags: Map<string, string[]> };

// Flags that never take a value. Every other flag takes the next argument verbatim, even one starting with "--", so a
// relayed value such as `--from "$SENDER"` or `--text "$MSG"` can never turn into a flag like --to-shell (#66).
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(["once", "force", "dry-run", "to-shell"]);

function parse(argv: readonly string[]): Args {
  const pos: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) { pos.push(a); continue; }
    const name = a.slice(2);
    const next = argv[i + 1];
    const value = BOOLEAN_FLAGS.has(name) || next === undefined ? "true" : (i++, next);
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { pos, flags };
}

const one = (a: Args, f: string): string | undefined => a.flags.get(f)?.at(-1);
const need = (v: string | undefined, what: string): string => {
  if (!v) throw new Refusal(`missing ${what}\n\n${USAGE}`);
  return v;
};

async function textOf(a: Args): Promise<string> {
  const t = one(a, "text");
  if (t !== undefined) return t;
  if (process.stdin.isTTY) throw new Refusal("give --text or pipe the message on stdin");
  return (await Bun.stdin.text()).trim();
}

async function status(d: Deps): Promise<void> {
  const roles = d.store.roles();
  const beat = d.store.heartbeat();
  console.log(`lead=${leadPane(d) ?? "-"} duty=${roles.duty ?? "-"} loop=${roles["duty-loop"] ?? "-"} beat=${beat ? `${Math.round((d.now() - beat.at) / 1000)}s ago` : "-"} home=${d.store.root}`);
  const reports = new Reports(d.flow.config.stateDir);
  for (const l of await d.flow.registry.open()) {
    const progress = reports.readLane(l);
    const heard = progress?.lastReport ? Date.parse(progress.lastReport.at) : l.lastReplyAt ?? Date.parse(l.openedAt);
    const last = progress?.lastReport ? reportLine(progress.lastReport) : "";
    console.log(`${l.key.padEnd(24)} ${statusOf(l).padEnd(13)} ${(l.pane ?? "-").padEnd(8)} heard ${Math.round((d.now() - heard) / 60_000)}m ago  ${last.slice(0, 70)}`);
  }
}

export async function main(argv: readonly string[], deps?: Deps): Promise<number> {
  if (isSkillCommand(argv)) return skillMain([...argv]);
  const a = parse(argv);
  const [cmd, x] = a.pos;
  if (cmd === undefined || cmd === "help" || cmd === "--help") { console.log(USAGE); return 0; }
  const d = deps ?? (await defaultDeps());
  if (cmd !== undefined && COMMANDS.has(cmd)) d.usage.touch();
  switch (cmd) {
    case "up":
      for (const line of await up(d, resolve(one(a, "cwd") ?? process.cwd()), Number(one(a, "interval") ?? "60"))) console.log(`UP ${line}`);
      return 0;
    case "role": {
      const role = need(x, "role") as Role;
      if (!ROLES.includes(role)) throw new Refusal(`role must be one of ${ROLES.join(", ")}`);
      const pane = need(a.pos[2] ?? d.mux.ownPane(), `pane id (not inside ${d.mux.kind}?)`);
      d.store.setRole(role, pane);
      console.log(`ROLE ${role}=${pane}`);
      return 0;
    }
    case "start": {
      const r = await startLane(d, need(x, "lane key"), need(one(a, "brief"), "--brief"), {
        done: need(one(a, "done"), "--done"), title: one(a, "title"), thread: one(a, "thread"), cwd: one(a, "cwd"), model: one(a, "model"),
      });
      console.log(`STARTED ${r.lane.key} pane=${r.lane.pane ?? "?"} brief=${r.lane.brief}`);
      console.log(r.startup);
      return 0;
    }
    case "report":
      console.log(await report(d, need(x, "lane key"), await textOf(a), one(a, "kind")));
      return 0;
    case "ready":
      console.log(await ready(d, need(x, "lane key"), await textOf(a), a.flags.get("evidence") ?? []));
      return 0;
    case "send": {
      const deliver = one(a, "to-shell") === "true" ? sendToShell : send;
      console.log(`${await deliver(d, need(x, "target"), await textOf(a), one(a, "from") ?? process.env["DORI_LANE"] ?? "cli")} ${x}`);
      return 0;
    }
    case "duty": {
      if (x === "stop") {
        d.store.setStop(d.now(), one(a, "text") ?? "stopped by hand", "duty");
        console.log("DUTY STOPPED");
        return 0;
      }
      if (x === "resume") {
        d.store.clearStop("duty");
        console.log("DUTY RESUMED");
        return 0;
      }
      if (x === "status") {
        const stop = d.store.stop("duty");
        console.log(stop ? `stopped: ${stop.reason}` : "running (no stop file)");
        return 0;
      }
      if (x !== undefined) throw new Refusal(`unknown duty command ${x}\n\n${USAGE}`);
      const interval = Number(one(a, "interval") ?? "60") * 1000;
      const mem = newDutyMemory(interval);
      console.log("DUTY_LOOP_READY");
      do {
        for (const e of await dutyTick(d, mem)) console.log(`DUTY ${[e.lane ?? e.pane, e.action].filter(Boolean).join(" ")}${e.detail ? `: ${e.detail}` : ""}`);
        if (one(a, "once")) break;
        await Bun.sleep(interval);
      } while (true);
      return 0;
    }
    case "duty-watch": {
      const loopMs = Number(one(a, "loop") ?? "1") * 60_000;
      const staleMs = Number(one(a, "stale-min") ?? "3") * 60_000;
      const state = { stale: false };
      console.log("DUTY_WATCH_READY");
      for (;;) {
        const line = dutyWatchTick(d, staleMs, state);
        if (line) console.log(line);
        if (loopMs <= 0) return state.stale ? 3 : 0;
        await Bun.sleep(loopMs);
      }
    }
    case "loop": {
      if (x === "stop") {
        d.store.setStop(d.now(), one(a, "text") ?? "stopped by hand");
        console.log("LOOP STOPPED");
        return 0;
      }
      if (x === "resume") {
        d.store.clearStop();
        console.log("LOOP RESUMED");
        return 0;
      }
      if (x === "status") {
        const stop = d.store.stop();
        const last = d.store.lastRun();
        const age = last ? Math.round((d.now() - last.at) / 60_000) : undefined;
        console.log(
          stop
            ? `stopped: ${stop.reason}`
            : `armed (no stop file; ${age === undefined ? "no run recorded yet" : `last run ${age}m ago`})`,
        );
        console.log(last ? summary(last) : "no run yet");
        return 0;
      }
      if (x !== undefined) throw new Refusal(`unknown loop command ${x}\n\n${USAGE}`);
      const interval = Number(one(a, "interval") ?? String(HOUR / 1000)) * 1000;
      const opts = {
        interval,
        maxLanes: Number(one(a, "max-lanes") ?? process.env["DORI_MAX_LANES"] ?? "3"),
        maxStarts: Number(one(a, "max-starts") ?? process.env["DORI_MAX_STARTS"] ?? "2"),
        force: one(a, "force") === "true",
        ...(one(a, "max-load") ?? process.env["DORI_MAX_LOAD"] ? { maxLoad: Number(one(a, "max-load") ?? process.env["DORI_MAX_LOAD"]) } : {}),
      };
      const count = (n: number): boolean => Number.isInteger(n) && n >= 0;
      if (!(Number.isFinite(interval) && interval > 0) || !count(opts.maxLanes) || !count(opts.maxStarts) ||
        !(opts.maxLoad === undefined || (Number.isFinite(opts.maxLoad) && opts.maxLoad > 0))) {
        throw new Refusal("--interval and --max-load must be finite positive numbers; --max-lanes and --max-starts whole numbers >= 0");
      }
      do {
        try {
          const run = await loopTick(d, opts);
          console.log(run.skipped ? `LOOP skipped: ${run.skipped}` : `LOOP started=${run.started.length} findings=${run.findings.length} asked=${run.asked.length}`);
        } catch (e) {
          console.error(`LOOP ERROR ${e instanceof Error ? e.message : String(e)}`);
          if (one(a, "once")) return 1;
        }
        if (one(a, "once")) break;
        opts.force = false;
        await Bun.sleep(msUntilNext(d, interval));
      } while (true);
      return 0;
    }
    case "backlog": {
      if (x === "add") {
        const id = need(a.pos[2], "item id");
        const p = one(a, "priority");
        const item = backlogAdd(d, id, need(one(a, "brief"), "--brief"), {
          title: one(a, "title"), cwd: one(a, "cwd"), decision: one(a, "decision"), done: need(one(a, "done"), "--done"),
          ...(p !== undefined ? { priority: Number(p) } : {}),
        });
        console.log(`ADDED ${item.id} p${item.priority}${item.decision ? " (needs decision)" : ""}`);
      } else if (x === "list" || x === undefined) {
        for (const i of d.store.items()) {
          console.log(`${i.id.padEnd(24)} ${i.status.padEnd(8)} p${i.priority}  ${i.decision ? `DECIDE: ${i.decision}` : i.title}`);
        }
      } else if (x === "decide") {
        const id = need(a.pos[2], "item id");
        backlogDecide(d, id, await textOf(a), one(a, "done"));
        console.log(`DECIDED ${id}`);
      } else if (x === "drop") {
        const id = need(a.pos[2], "item id");
        backlogDrop(d, id, one(a, "text"));
        console.log(`DROPPED ${id}`);
      } else if (x === "import") {
        const { added, capped } = await backlogImport(d, need(a.pos[2], "owner/repo"), one(a, "label") ?? "dori", one(a, "cwd"));
        console.log(`IMPORTED ${added.length}${added.length ? `: ${added.join(", ")}` : ""}`);
        if (capped) console.error(`WARNING: gh returned ${IMPORT_LIMIT} issues, the import limit; some labelled issues may be missing`);
      } else {
        throw new Refusal(`unknown backlog command ${x}\n\n${USAGE}`);
      }
      return 0;
    }
    case "review": {
      const r = await review(d, need(x, "PR"), one(a, "model"));
      console.log(`REVIEW ${x} head=${r.sha} verdict=${r.verdict}`);
      return r.verdict === "CLEAR" ? 0 : 1;
    }
    case "merge":
      console.log(await mergeGate(d, need(x, "PR"), { dryRun: one(a, "dry-run") === "true" }));
      return 0;
    case "done":
      for (const line of await done(d, need(x, "lane key"))) console.log(line);
      return 0;
    case "status":
      await status(d);
      return 0;
    default:
      console.log(USAGE);
      return 64;
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (isSkillCommand(argv)) process.exit(await skillMain(argv));
  const deps = await defaultDeps();
  let code = 0;
  try { code = await main(argv, deps); }
  catch (e) { if (!(e instanceof Refusal)) throw e; console.error(e.message); code = 2; }
  finally { await deps.usage.flush(2000); }
  process.exit(code);
}
