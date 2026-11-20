/** dori lead-pump --bot B [--once]: feed the bot's lead from its inbox, one tick every 2 s (one tick with --once). */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";

import { OmoHostError } from "../../../../src/runtime/omo-host/exec.ts";
import { type Command, die } from "./cli-context.ts";
import { pidAlive } from "./heavy-slot.ts";
import { type LeadInboxError, parseBot } from "./lead-envelope.ts";
import { LeadInbox } from "./lead-inbox.ts";
import { LeadPump, RetiredLeadError } from "./lead-pump.ts";
import { parseHostStatus } from "./lead-pump-text.ts";
import { type Clock, type Runner, realClock, runtimesFor } from "./run.ts";

const TICK_MS = 2_000;
/** Every omo call the pump makes is killed after 120 s: a prompt that hangs for minutes becomes an ambiguous result. */
const CALL_MS = 120_000;

export const bounded =
  (runner: Runner): Runner =>
  (argv, opts) =>
    runner(argv, { ...opts, timeoutMs: CALL_MS });

/** `read` straight into a file: a pipe would cut the JSON line at 64 KiB. */
const readToFile =
  (dir: string) =>
  async (id: string, opts: { readonly tail?: number; readonly messages: boolean }): Promise<string> => {
    const file = join(dir, `.read-${process.pid}.json`);
    const tail = opts.tail === undefined ? [] : ["--tail", String(opts.tail)];
    const argv = ["host", "session", "read", id, ...(opts.messages ? ["--messages"] : []), ...tail, "--json"];
    const p = Bun.spawn(["omo", ...argv], { stdout: Bun.file(file), stderr: "pipe", timeout: CALL_MS });
    const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    const out = readFileSync(file, "utf8");
    rmSync(file, { force: true });
    if (code === 0) return out;
    const reason = /"reason":"([a-z_]+)"/.exec(out)?.[1];
    throw new OmoHostError(argv, { code, stdout: out, stderr: err }, reason, (err || out).trim().slice(0, 200));
  };

/** One pump per bot: a lock directory holding the owner's pid, taken over only from a dead owner. */
const lock = (dir: string, bot: string): (() => void) => {
  const path = join(dir, `${bot}.pump.lock`);
  mkdirSync(dir, { recursive: true });
  const take = (): boolean => {
    try {
      mkdirSync(path);
    } catch {
      return false;
    }
    writeFileSync(join(path, "pid"), String(process.pid));
    return true;
  };
  if (!take()) {
    let owner = Number.NaN;
    try {
      owner = Number(readFileSync(join(path, "pid"), "utf8"));
    } catch {}
    if (pidAlive(owner)) die(`a lead pump for ${bot} already runs (pid ${owner})`, 3);
    rmSync(path, { recursive: true, force: true });
    if (!take()) die(`could not take the lead pump lock ${path}`, 3);
  }
  return () => rmSync(path, { recursive: true, force: true });
};

export const runPump = async (pump: LeadPump, clock: Clock, once: boolean): Promise<void> => {
  for (;;) {
    try {
      await pump.tick();
    } catch (e) {
      if (once) throw e;
      console.log(`WARN lead-pump ${e instanceof Error ? e.message : String(e)}`.slice(0, 300));
    }
    if (once) return await pump.health();
    await clock.sleep(TICK_MS);
  }
};

const leadPump: Command = async ({ need, values, config, deps }) => {
  let bot: string;
  try {
    bot = parseBot(need("bot"));
  } catch (e) {
    return die((e as LeadInboxError).message, 2);
  }
  const unlock = lock(join(config.stateDir, "lead"), bot);
  const inbox = new LeadInbox(config.stateDir, bot, realClock);
  const run = bounded(deps.run);
  try {
    const pump = new LeadPump({
      stateDir: config.stateDir,
      bot,
      clock: realClock,
      inbox,
      runtimes: runtimesFor(config, process.env, run, realClock),
      host: async () => parseHostStatus((await run(["omo", "host", "status", "--json"])).out),
      transcript: readToFile(join(config.stateDir, "lead")),
      run,
      hookArgv: config.hooks.inboxAccepted,
      bootTime: new Date(Math.floor((Date.now() - uptime() * 1000) / 1000) * 1000).toISOString(),
    });
    await runPump(pump, realClock, values["once"] === true);
  } catch (e) {
    if (e instanceof RetiredLeadError) die(e.message);
    throw e;
  } finally {
    inbox.close();
    unlock();
  }
};

export const leadPumpCommands: Readonly<Record<string, Command>> = { "lead-pump": leadPump };
