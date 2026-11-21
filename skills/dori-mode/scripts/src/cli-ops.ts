/** dori sync, boot, verify-pr and the host loops: watch, freshness, forward-reports, dead-panes, guard, heavy, can-launch. */
import { dirname, join, resolve } from "node:path";
import { bootCheck, envSlackCheck } from "./boot.ts";
import { gatewayCheck } from "./boot-gateway.ts";
import { type Command, die, every, slackAuth } from "./cli-context.ts";
import { deadPaneTick, newDeadPaneState } from "./dead-panes.ts";
import { watchTick } from "./done-flow.ts";
import { freshnessTick } from "./freshness.ts";
import { acquireSlot, pidAlive, releaseSlot } from "./heavy-slot.ts";
import { guardTick, sampleHost } from "./host-guard.ts";
import { Gateway, gatewaySocketPath, unixConnector } from "./messenger/gateway.ts";
import { fetchHttp } from "./messenger/http.ts";
import { Slack } from "./messenger/slack.ts";
import { ConfigError } from "./config.ts";
import { LeadInboxError, parseBot } from "./lead-envelope.ts";
import { Registry } from "./registry.ts";
import { forwarderDeps, forwardTick, localInboxArgv } from "./report-forwarder.ts";
import { Reports } from "./reports.ts";
import { canLaunch } from "./routing.ts";
import { realClock, run } from "./run.ts";
import { syncRegistry } from "./sync.ts";
import { formatVerifyPr, verifyPr } from "./verify-pr.ts";
import { Worklog } from "./worklog.ts";

const sync: Command = async ({ values, deps }) => {
  const r = await syncRegistry(deps, Boolean(values["write"]));
  console.log("key | thread | pane | session | status");
  for (const row of [...r.rows, ...r.unregistered])
    console.log([row.key, row.thread, row.pane, row.session, row.status].join(" | "));
  console.log(r.drift.length ? `DRIFT (${r.drift.length}):\n${r.drift.map((d) => `- ${d}`).join("\n")}` : "DRIFT none");
  console.log(values["write"] ? "WROTE session ids" : "READ_ONLY");
};

const boot: Command = async ({ deps, config }) => {
  const sessionDirs = [
    process.env["PI_SESSION_DIR"],
    process.env["PI_SESSION_FILE"] && dirname(process.env["PI_SESSION_FILE"]),
  ];
  const socket = gatewaySocketPath(config.gateway.socket);
  const r = await bootCheck({
    ...deps,
    reports: new Reports(config.stateDir),
    worklog: new Worklog(config.stateDir),
    // A bad token file is a failed boot line, not an exit: boot is the read-only report a fresh lead depends on.
    slack: envSlackCheck((token) => new Slack(fetchHttp, realClock, slackAuth(token))),
    // No socket file is not a Dori VM: the surface is skipped, as Slack is with no token.
    gateway: gatewayCheck(new Gateway(unixConnector, realClock, socket), socket),
    monitorDirs: sessionDirs.flatMap((dir) => (dir ? [join(dir, "extensions", "terminal")] : [])),
  });
  for (const line of r.lines) console.log(line);
  process.exit(r.exitCode);
};

const verifyPrCommand: Command = async ({ key, positionals, opt, config }) => {
  const repo = key ?? die("verify-pr needs owner/repo and a PR number");
  const expectedIdentity = config.repoIdentities[repo.toLowerCase()],
    cwd = opt("cwd");
  const result = await verifyPr(repo, Number(positionals[1]), run, {
    ...(expectedIdentity !== undefined ? { expectedIdentity } : {}),
    loopCount: Number(opt("loop") ?? 20),
    ...(cwd !== undefined ? { cwd } : {}),
  });
  console.log(formatVerifyPr(result));
  process.exit(result.ok ? 0 : 2);
};

const heavy: Command = async ({ rest, config }) => {
  const sep = rest.indexOf("--");
  const label = rest[0];
  const cmd = sep >= 0 ? rest.slice(sep + 1) : [];
  if (!label || label === "--" || !cmd.length) die("usage: dori heavy <label> -- <command ...>");
  const load = async () => (await sampleHost(run)).load1;
  const slot = await acquireSlot(
    {
      dir: `${config.stateDir}/heavy`,
      slots: config.heavySlots,
      maxLoad: config.heavyMaxLoad,
      clock: realClock,
      load,
      alive: pidAlive,
      pid: process.pid,
    },
    label ?? "",
  );
  try {
    const child = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
    process.exitCode = await child.exited;
  } finally {
    releaseSlot(slot);
  }
};

const FORWARD_EVERY_MS = 15_000;

export const opsCommands: Readonly<Record<string, Command>> = {
  sync,
  boot,
  "verify-pr": verifyPrCommand,
  watch: async ({ deps }) => {
    console.log("LANE_WATCH_READY");
    for (;;) {
      for (const line of await watchTick(deps).catch((e: unknown) => [`LANE_WATCH_WARN ${String(e).slice(0, 200)}`]))
        console.log(line);
      await Bun.sleep(30_000);
    }
  },
  freshness: async ({ loopMinutes, deps }) => {
    await every(loopMinutes(), async () => {
      for (const a of await freshnessTick(deps, process.env["HOME"] ?? ""))
        console.log(`${a.kind.toUpperCase()} ${a.lane} ${a.detail}`);
    });
  },
  "forward-reports": async ({ values, config, deps }) => {
    // --state-dir reads another dori home's lane journals (an omp node home); --bot names the local inbox it fills.
    const stateDir = typeof values["state-dir"] === "string" ? resolve(values["state-dir"]) : config.stateDir;
    const bot = typeof values["bot"] === "string" ? values["bot"] : undefined;
    const forwarder = (() => {
      try {
        if (bot !== undefined) parseBot(bot);
        const base = forwarderDeps({ ...config, stateDir }, deps.run, new Registry(stateDir));
        return bot === undefined || config.leadInboxArgv ? base : { ...base, inboxArgv: localInboxArgv(bot) };
      } catch (e) {
        if (e instanceof ConfigError) return die(e.message);
        if (e instanceof LeadInboxError) return die(e.message, 2);
        throw e;
      }
    })();
    for (;;) {
      const acts = await forwardTick(forwarder).catch((e: unknown) => {
        if (values["once"]) throw e;
        return [{ kind: "failed", lane: "-", detail: e instanceof Error ? e.message : String(e) }];
      });
      for (const a of acts) console.log(`${a.kind.toUpperCase()} ${a.lane} ${a.detail}`);
      if (values["once"]) process.exit(acts.some((a) => a.kind === "failed") ? 1 : 0);
      await realClock.sleep(FORWARD_EVERY_MS);
    }
  },
  "dead-panes": async ({ loopMinutes, config }) => {
    const seen = new Set<string>();
    const paneState = newDeadPaneState();
    await every(loopMinutes(), async () => {
      for (const line of await deadPaneTick(run, config, seen, new Date().toISOString().slice(0, 13), paneState))
        console.log(line);
    });
  },
  guard: async ({ loopMinutes, config }) => {
    const state = { alerting: false };
    const minutes = loopMinutes();
    console.log("HOST_GUARD_READY");
    await every(minutes, async () => {
      for (const line of guardTick(await sampleHost(run), config.guard, state)) console.log(line);
    });
  },
  heavy,
  "can-launch": async ({ config }) => {
    const v = canLaunch(await sampleHost(run), config.guard);
    console.log(v.ok ? "CAN_LAUNCH" : `HOLD ${v.reasons.join(" | ")}`);
    process.exit(v.ok ? 0 : 4);
  },
};
