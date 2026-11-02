#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  defaultDeps, done, dutyTick, dutyWatchTick, leadPane, mergeGate, newDutyMemory, ready, Refusal, report, review, send, startLane, up, ROLES, type Deps,
} from "./harness.ts";
import { statusOf } from "../skills/dori-mode/scripts/src/registry.ts";
import type { Role } from "./store.ts";

const SKILL_CLI = join(import.meta.dir, "..", "skills", "dori-mode", "scripts", "src", "cli.ts");
const SKILL_COMMANDS: ReadonlySet<string> = new Set([
  "launch", "adopt", "sync", "claim-done", "object-done", "close", "pause", "resume", "watch", "freshness",
  "dead-panes", "guard", "heavy", "can-launch", "presence", "transcribe", "inbound",
]);
const MESSENGERS: ReadonlySet<string> = new Set(["slack", "telegram", "discord"]);

/** Dori mode owns these commands; `send` is Dori mode's only when it names a messenger. */
export const isSkillCommand = (argv: readonly string[]): boolean => {
  const [cmd, x] = argv;
  if (cmd === undefined) return false;
  return SKILL_COMMANDS.has(cmd) || (cmd === "send" && x !== undefined && MESSENGERS.has(x));
};

const USAGE = `dori - a proactive multi-session harness on herdr (or hc) + omo

  dori up [--cwd DIR] [--interval SECONDS]    make sure lead, duty session and duty loop run; never starts a
                                              second lead (lead = roles.json or config leadPane). Safe every minute
  dori role <lead|duty> [PANE]                register a pane as lead or duty (default: this pane)
  dori start <key> --brief FILE --done "SIGNALS" [--title T] [--thread REF] [--cwd DIR] [--model M]
                                              open a lane (same as dori launch) and tell the lead
  dori report <key> --text T [--kind milestone|blocker|question|done]
  dori ready <key> --text T --evidence LINK [--evidence LINK ...]   a done claim with the final answer
  dori send <lead|duty|key|pane> --text T     deliver now, or queue until the pane is an idle agent
  dori duty [--once] [--interval SECONDS]     inbox, LOST, freshness, dead panes, escalations; writes a heartbeat
  dori duty-watch [--loop MIN] [--stale-min N]  DUTY_STALE when the duty loop's heartbeat is older than N min
  dori review <owner/repo#N> [--model M]      fresh omo reviewer at the exact head -> receipt
  dori merge <owner/repo#N> [--dry-run]       CLEAR receipt at head + green checks -> squash merge
  dori done <key>                             close a lane now (its Done signals must read back live)
  dori status

--text may be omitted to read the message from stdin.
Multiplexer: DORI_MUX=herdr|hc, or "mux" in ~/.dori/config.json (default herdr).

Dori mode commands run the skill's CLI (skills/dori-mode/scripts, also installed as dori-mode):
  ${[...SKILL_COMMANDS].join(", ")}, send <slack|telegram|discord>. Run: dori-mode help`;

type Args = { pos: string[]; flags: Map<string, string[]> };

function parse(argv: readonly string[]): Args {
  const pos: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) { pos.push(a); continue; }
    const name = a.slice(2);
    const next = argv[i + 1];
    const value = next !== undefined && !next.startsWith("--") ? (i++, next) : "true";
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
  for (const l of await d.flow.registry.open()) {
    const heard = l.lastReplyAt ?? Date.parse(l.openedAt);
    console.log(`${l.key.padEnd(24)} ${statusOf(l).padEnd(13)} ${(l.pane ?? "-").padEnd(8)} heard ${Math.round((d.now() - heard) / 60_000)}m ago  ${(l.lastReport ?? "").slice(0, 70)}`);
  }
}

export async function main(argv: readonly string[], deps?: Deps): Promise<number> {
  const a = parse(argv);
  const [cmd, x] = a.pos;
  if (cmd === undefined || cmd === "help" || cmd === "--help") { console.log(USAGE); return 0; }
  const d = deps ?? (await defaultDeps());
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
    case "send":
      console.log(`${await send(d, need(x, "target"), await textOf(a), one(a, "from") ?? process.env["DORI_LANE"] ?? "cli")} ${x}`);
      return 0;
    case "duty": {
      const interval = Number(one(a, "interval") ?? "60") * 1000;
      const mem = newDutyMemory(interval);
      console.log("DUTY_LOOP_READY");
      do {
        for (const e of await dutyTick(d, mem)) console.log(`DUTY ${e.lane ?? e.pane ?? "-"} ${e.action}`);
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
  if (isSkillCommand(argv)) {
    process.argv = [process.argv[0]!, SKILL_CLI, ...argv];
    await import(SKILL_CLI);
  } else {
    try {
      process.exit(await main(argv));
    } catch (e) {
      if (e instanceof Refusal) { console.error(e.message); process.exit(2); }
      throw e;
    }
  }
}
