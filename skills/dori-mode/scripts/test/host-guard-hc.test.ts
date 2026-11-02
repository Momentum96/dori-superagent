import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config.ts";
import { alertReasons, sampleHost } from "../src/host-guard.ts";
import type { Runner } from "../src/run.ts";

test("on hc the pane count is this machine's live terminals from hc ls, so panesMax alerts", async () => {
  const calls: string[] = [];
  const run: Runner = async (argv) => {
    const k = argv.join(" ");
    calls.push(k);
    if (k === "hc ls --json") {
      return { code: 0, err: "", out: JSON.stringify({ machines: [{ name: "macmini", state: "connected" }], terminals: [
        { address: "t3", state: "live", agent: "omo" },
        { address: "t2h", state: "live", agent: "omo" },
        { address: "t2m", state: "live" },
        { address: "t7", state: "finished" },
        { address: "macmini/t3", state: "live", agent: "omo" },
      ] }) };
    }
    return { code: 127, out: "", err: "not found" };
  };
  const s = await sampleHost(run, "/", "hc");
  expect(s.panes).toBe(3);
  expect(calls).not.toContain("herdr pane list");
  expect(alertReasons(s, { ...defaultConfig("/home/test").guard, diskFreeMinGb: 0, memFreeMinPct: 0, panesMax: 2 })).toEqual(["panes 3 > 2"]);
});
