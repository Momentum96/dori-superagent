import type { GuardThresholds, Mux } from "./config.ts";
import type { Runner } from "./run.ts";

export type HostSample = {
  readonly load1: number;
  readonly memFreePct: number;
  readonly diskFreeGb: number;
  readonly swapFreeGb: number;
  readonly panes: number;
};

const num = (s: string | undefined, fallback: number): number => {
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
};

/** Live terminals on this machine; another machine's terminals (`macmini/t3`) are not counted. -1 when hc does not answer. */
const hcPanes = async (run: Runner): Promise<number> => {
  const ls = await run(["hc", "ls", "--json"]);
  if (ls.code !== 0) return -1;
  const terminals = (JSON.parse(ls.out) as { terminals?: { address: string; state?: string }[] }).terminals ?? [];
  return terminals.filter((t) => t.state === "live" && !t.address.includes("/")).length;
};

export const sampleHost = async (run: Runner, dataPath = "/", mux: Mux = "herdr"): Promise<HostSample> => {
  const load = await run(["sysctl", "-n", "vm.loadavg"]);
  const loadLinux = load.code === 0 ? null : await run(["cat", "/proc/loadavg"]);
  const load1 = num((load.code === 0 ? load.out.replace(/[{}]/g, "").trim() : loadLinux?.out ?? "").split(/\s+/)[0], 0);
  const mp = await run(["memory_pressure", "-Q"]);
  const meminfo = mp.code === 0 ? null : await run(["cat", "/proc/meminfo"]);
  const kb = (key: string): number => num(new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(meminfo?.out ?? "")?.[1], NaN);
  const memFreePct = mp.code === 0
    ? num(/free percentage: (\d+)%/.exec(mp.out)?.[1], 100)
    : kb("MemTotal") > 0 ? Math.round((kb("MemAvailable") / kb("MemTotal")) * 100) : 100;
  const df = await run(["df", "-k", dataPath]);
  const diskFreeGb = num(df.out.split("\n").at(-1)?.trim().split(/\s+/)[3], 0) / 1_048_576;
  const swap = await run(["sysctl", "-n", "vm.swapusage"]);
  const swapFreeGb = swap.code === 0 ? num(/free = ([\d.]+)M/.exec(swap.out)?.[1], 0) / 1024 : num(String(kb("SwapFree")), 0) / 1_048_576;
  let panes: number;
  if (mux === "hc") panes = await hcPanes(run);
  else {
    const pl = await run(["herdr", "pane", "list"]);
    panes = pl.code === 0 ? (JSON.parse(pl.out) as { result: { panes: unknown[] } }).result.panes.length : -1;
  }
  return { load1, memFreePct, diskFreeGb, swapFreeGb, panes };
};

export const alertReasons = (s: HostSample, t: GuardThresholds): string[] => {
  const r: string[] = [];
  if (s.load1 > t.loadAlert) r.push(`load ${s.load1.toFixed(0)} > ${t.loadAlert}`);
  if (s.memFreePct < t.memFreeMinPct) r.push(`memory free ${s.memFreePct}% < ${t.memFreeMinPct}%`);
  if (s.diskFreeGb < t.diskFreeMinGb) r.push(`disk free ${s.diskFreeGb.toFixed(0)} GB < ${t.diskFreeMinGb} GB`);
  if (t.panesMax > 0 && s.panes > t.panesMax) r.push(`panes ${s.panes} > ${t.panesMax}`);
  return r;
};

export type GuardState = { alerting: boolean; computeReady?: boolean };

export const guardTick = (s: HostSample, t: GuardThresholds, state: GuardState): string[] => {
  const out: string[] = [];
  const reasons = alertReasons(s, t);
  const alerting = reasons.length > 0;
  if (alerting !== state.alerting) {
    out.push(alerting
      ? `HOST_GUARD ALERT ${reasons.join(" | ")}`
      : `HOST_GUARD CLEAR load ${s.load1.toFixed(0)}, memory free ${s.memFreePct}%, disk free ${s.diskFreeGb.toFixed(0)} GB, swap free ${s.swapFreeGb.toFixed(1)} GB`);
    state.alerting = alerting;
  }
  const ready = s.load1 < t.loadOk;
  if (ready !== state.computeReady) {
    out.push(ready ? `HOST_GUARD COMPUTE_READY load ${s.load1.toFixed(0)} < ${t.loadOk}` : `HOST_GUARD COMPUTE_BUSY load ${s.load1.toFixed(0)}`);
    state.computeReady = ready;
  }
  return out;
};
