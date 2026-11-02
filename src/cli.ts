#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  defaultDeps, done, dutyTick, mergeGate, ready, Refusal, report, review, send, startLane, ROLES, type Deps,
} from "./harness.ts";
import { shq } from "./herdr.ts";
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

  dori up [--cwd DIR]                         open lead + duty panes (herdr: a new workspace; hc: new terminals)
  dori role <lead|duty> [PANE]                register a pane as lead or duty (default: this pane)
  dori start <key> --brief FILE [--cwd DIR]   open a lane: new tab, omo session, brief + lane rules
  dori report <key> --text T [--status working|waiting]
  dori ready <key> --text T --evidence LINK [--evidence LINK ...]
  dori send <lead|duty|key|pane> --text T     deliver now, or queue until the pane is idle
  dori duty [--once] [--interval SECONDS]     flush inboxes, nudge idle lanes, escalate, detect lost lanes
  dori review <owner/repo#N> [--model M]      fresh omo reviewer at the exact head -> receipt
  dori merge <owner/repo#N> [--dry-run]       CLEAR receipt at head + green checks -> squash merge
  dori done <key>                             lead closes a READY lane
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

function renderPrompt(d: Deps, name: string): string {
  const dir = join(d.store.root, "prompts");
  mkdirSync(dir, { recursive: true });
  const src = readFileSync(join(import.meta.dir, "..", "prompts", name), "utf8").replaceAll("{{dori}}", d.doriCmd);
  const out = join(dir, name);
  writeFileSync(out, src);
  return out;
}

async function up(d: Deps, cwd: string): Promise<void> {
  const env = { DORI_HOME: d.store.root, DORI_MUX: d.mux.kind };
  const lead = await d.mux.createWorkspace("dori", cwd);
  await d.mux.run(lead.paneId, `${d.agentCmd} --append-system-prompt ${shq(renderPrompt(d, "lead.md"))}`);
  d.store.setRole("lead", lead.paneId);
  const duty = await d.mux.createTab("duty", cwd, lead.workspaceId, env);
  await d.mux.run(duty.paneId, `${d.agentCmd} --append-system-prompt ${shq(renderPrompt(d, "duty.md"))}`);
  d.store.setRole("duty", duty.paneId);
  const loop = await d.mux.split(duty.paneId, cwd, env);
  await d.mux.run(loop.paneId, `${d.doriCmd} duty --interval 60`);
  console.log(`UP lead=${lead.paneId} duty=${duty.paneId} loop=${loop.paneId} home=${d.store.root}`);
}

function status(d: Deps): void {
  const roles = d.store.roles();
  console.log(`lead=${roles.lead ?? "-"} duty=${roles.duty ?? "-"} home=${d.store.root}`);
  for (const l of d.store.lanes()) {
    const last = l.log.at(-1);
    const age = Math.round((d.now() - l.lastActivityAt) / 60_000);
    console.log(`${l.key.padEnd(24)} ${l.status.padEnd(8)} ${l.paneId.padEnd(8)} active ${age}m ago  ${last ? `${last.kind}: ${last.text.slice(0, 60)}` : ""}`);
  }
}

export async function main(argv: readonly string[], d: Deps = defaultDeps()): Promise<number> {
  const a = parse(argv);
  const [cmd, x] = a.pos;
  switch (cmd) {
    case "up":
      await up(d, resolve(one(a, "cwd") ?? process.cwd()));
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
      const lane = await startLane(d, need(x, "lane key"), need(one(a, "brief"), "--brief"), {
        cwd: one(a, "cwd"), workspace: one(a, "workspace"),
      });
      console.log(`STARTED ${lane.key} pane=${lane.paneId} brief=${lane.brief}`);
      return 0;
    }
    case "report": {
      const st = one(a, "status");
      if (st && st !== "working" && st !== "waiting") throw new Refusal("--status must be working or waiting");
      await report(d, need(x, "lane key"), await textOf(a), st as "working" | "waiting" | undefined);
      console.log(`REPORTED ${x}`);
      return 0;
    }
    case "ready":
      await ready(d, need(x, "lane key"), await textOf(a), a.flags.get("evidence") ?? []);
      console.log(`READY ${x}`);
      return 0;
    case "send":
      console.log(`${await send(d, need(x, "target"), await textOf(a), one(a, "from") ?? process.env["DORI_LANE"] ?? "cli")} ${x}`);
      return 0;
    case "duty": {
      const interval = Number(one(a, "interval") ?? "60") * 1000;
      do {
        for (const e of await dutyTick(d)) console.log(`DUTY ${e.lane ?? e.pane} ${e.action}`);
        if (one(a, "once")) break;
        await Bun.sleep(interval);
      } while (true);
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
      await done(d, need(x, "lane key"));
      console.log(`DONE ${x}`);
      return 0;
    case "status":
      status(d);
      return 0;
    default:
      console.log(USAGE);
      return cmd === undefined || cmd === "help" || cmd === "--help" ? 0 : 64;
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
