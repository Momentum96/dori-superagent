import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultConfig, loadConfig } from "../skills/dori-mode/scripts/src/config.ts";
import { hcRunner } from "../skills/dori-mode/scripts/src/hc-runner.ts";
import { Registry } from "../skills/dori-mode/scripts/src/registry.ts";
import { isSkillCommand } from "../src/cli.ts";
import { done, dutyTick, send, sendToShell, startLane, up, type Deps } from "../src/harness.ts";
import { Hc } from "../src/hc.ts";
import type { Exec } from "../src/herdr.ts";
import { Store } from "../src/store.ts";

type Term = { state: "live" | "finished"; status: { app: string; state: string } | null; foreground?: { name: string; argv: string[] }; labels: Record<string, string>; received: string[] };

class HcWorld {
  terms = new Map<string, Term>();
  calls: string[][] = [];
  next = 10;

  add(address: string, state: string | null): Term {
    const t: Term = { state: "live", status: state ? { app: "omo", state } : null, labels: {}, received: [] };
    this.terms.set(address, t);
    return t;
  }

  exec: Exec = async (cmd, argv) => {
    this.calls.push([cmd, ...argv]);
    const ok = (out: unknown = "") => ({ code: 0, stdout: typeof out === "string" ? out : JSON.stringify(out), stderr: "" });
    if (cmd !== "hc") return { code: 1, stdout: "", stderr: `no ${cmd} here` };
    const [verb, address = ""] = argv;
    if (verb === "run") {
      const t = this.add(`t${++this.next}`, null);
      for (let i = 0; i < argv.length; i++) if (argv[i] === "--label") { const [k, v] = argv[i + 1]!.split("="); t.labels[k!] = v!; }
      return ok({ address: `t${this.next}`, state: "live" });
    }
    if (verb === "ls") return ok({ terminals: [...this.terms].filter(([, t]) => t.state === "live").map(([a, t]) => ({ address: a, ...(t.status ? { agent: t.status.app, status: t.status.state } : {}) })) });
    const t = this.terms.get(address);
    if (!t) return { code: 3, stdout: "", stderr: JSON.stringify({ error: { kind: "not_found", message: `no terminal ${address}` } }) };
    if (verb === "get") return ok({ address, pid: 1, state: t.state, status: t.status, labels: t.labels, foreground: t.foreground ?? (t.status ? { name: "omo", argv: ["omo"] } : { name: "zsh", argv: ["zsh"] }) });
    if (verb === "send") {
      t.received.push(argv[2]!);
      if (!t.status && /^omo\b/.test(argv[2]!)) t.status = { app: "omo", state: "idle" };
      return ok({ started: true });
    }
    if (verb === "read") return ok("Pursuing goal");
    if (verb === "kill") { t.state = "finished"; return ok(); }
    if (verb === "wait") return ok();
    if (verb === "rm") { this.terms.delete(address); return ok(); }
    return { code: 1, stdout: "", stderr: `unhandled ${argv.join(" ")}` };
  };

  deps(space?: string): Deps {
    const stateDir = mkdtempSync(join(tmpdir(), "dori-hc-state-"));
    const run = hcRunner(async (argv) => {
      const r = await this.exec(argv[0]!, argv.slice(1));
      return { code: r.code, out: r.stdout.trim(), err: r.stderr.trim() };
    });
    const config = { ...defaultConfig("/home/test"), mux: "hc" as const, stateDir, defaultCwd: stateDir, leadPane: "t3", laneWorkspace: space ?? "" };
    return {
      store: new Store(mkdtempSync(join(tmpdir(), "dori-hc-test-"))),
      mux: new Hc(this.exec, space, "/bin/zsh"),
      exec: this.exec,
      now: () => 1_000_000,
      agentCmd: "omo",
      doriCmd: "dori",
      host: () => ({ load1: 0, cores: 8, memFreePct: 50 }),
      usage: { touch() {}, record() {}, duty() {}, async flush() {} },
      flow: { run, clock: { now: () => 1_000_000, sleep: async () => {} }, registry: new Registry(stateDir), config, exists: () => true },
    };
  }
}

const briefIn = (d: Deps) => {
  const brief = join(d.store.root, "brief.md");
  writeFileSync(brief, "Fix the flaky login test.");
  return brief;
};

describe("hc multiplexer", () => {
  test("status maps hc's reported agent state; no status is a shell; finished or missing is gone", async () => {
    const w = new HcWorld();
    const hc = new Hc(w.exec);
    w.add("t1", "working");
    w.add("t2", null);
    w.add("t3", "error");
    w.add("t4", "idle").state = "finished";
    expect(await hc.status("t1")).toBe("working");
    expect(await hc.status("t2")).toBe("shell");
    expect(await hc.status("t3")).toBe("unknown");
    expect(await hc.status("t4")).toBe("gone");
    expect(await hc.status("t99")).toBe("gone");
  });

  test("a lane opens through Dori mode's launch as a named terminal in the space, and [START] reaches the config's lead", async () => {
    const w = new HcWorld();
    const d = w.deps("sp1");
    const lead = w.add("t3", "idle");
    const brief = briefIn(d);
    const { lane } = await startLane(d, "fix-login", brief, { done: `file ${brief}`, cwd: "/repo" });
    expect(lane.pane).toBe("t11");
    expect(w.calls.find((c) => c[1] === "run")).toEqual([
      "hc", "run", "--bg", "--json", "--outlive-parent", "--no-notify", "--name", "fix-login", "--cwd", "/repo",
      "--label", "herdr.space=sp1", "--label", "dori.lane=fix-login",
    ]);
    expect(w.terms.get("t11")!.received[0]).toStartWith("omo --model");
    expect(lead.received[0]).toStartWith("[START fix-login] lane opened in t11: STARTUP_OK");
  });

  test("a terminal that runs no agent never gets mail: it stays queued and nothing is typed until an agent is idle there", async () => {
    const w = new HcWorld();
    const d = w.deps();
    const shell = w.add("t5", null);
    expect(await send(d, "t5", "rm -rf ~/work", "cli")).toBe("QUEUED");
    expect(await dutyTick(d)).not.toContainEqual({ pane: "t5", action: "flushed" });
    await expect(sendToShell(d, "t5", "unsafe", "cli")).rejects.toThrow("not supported on hc");
    expect(await d.mux.deliver("t5", "unsafe")).toBe(false);
    expect(shell.received).toEqual([]);
    expect(w.calls.some((c) => c[1] === "send" && c[2] === "t5")).toBe(false);
    shell.status = { app: "omo", state: "idle" };
    expect(await dutyTick(d)).toContainEqual({ pane: "t5", action: "flushed" });
    expect(shell.received).toEqual(["rm -rf ~/work"]);
  });

  test("done closes a lane whose Done signal is live: the terminal is killed, waited and removed", async () => {
    const w = new HcWorld();
    const d = w.deps();
    w.add("t3", "idle");
    const brief = briefIn(d);
    const { lane } = await startLane(d, "a-lane", brief, { done: `file ${brief}`, cwd: "/repo" });
    expect((await done(d, "a-lane")).at(-1)).toStartWith("CLOSED a-lane");
    expect(w.terms.has(lane.pane!)).toBe(false);
    expect(w.calls.filter((c) => c[2] === lane.pane && ["kill", "wait", "rm"].includes(c[1]!)).map((c) => c[1])).toEqual(["kill", "wait", "rm"]);
  });

  test("stale OSC idle with a shell foreground holds mail until the agent returns", async () => {
    const w = new HcWorld();
    const d = w.deps();
    const pane = w.add("t8", "idle");
    pane.foreground = { name: "zsh", argv: ["zsh", "-i"] };
    expect(await send(d, "t8", "unsafe shell text", "cli")).toBe("QUEUED");
    expect(pane.received).toEqual([]);
    expect(d.store.queued("t8")).toHaveLength(1);
    pane.foreground = { name: "omo", argv: ["omo"] };
    expect(await dutyTick(d)).toContainEqual({ pane: "t8", action: "flushed" });
    expect(pane.received).toEqual(["unsafe shell text"]);
    expect(d.store.queued("t8")).toEqual([]);
  });

  test("dori up without a space opens exactly the duty and both loop terminals, never a workspace shell or a second lead", async () => {
    const w = new HcWorld();
    const d = w.deps();
    w.add("t3", "idle");
    const lines = await up(d, "/repo");
    expect(lines[0]).toBe("LEAD t3 idle");
    const runs = w.calls.filter((c) => c[1] === "run");
    expect(runs).toHaveLength(3);
    expect(runs.map((r) => r[r.indexOf("--name") + 1])).toEqual(["duty", "hourly-loop", "duty-loop"]);
    await up(d, "/repo");
    expect(w.calls.filter((c) => c[1] === "run")).toHaveLength(3);
    expect(runs.flat().some((a) => a.startsWith("herdr.space=") || a.startsWith("dori.workspace="))).toBe(false);
  });

  test("hc addresses are pane ids for dori send; herdr ids and lane keys are not", () => {
    const hc = new Hc(new HcWorld().exec);
    expect(["t3", "t1b", "macmini/t7"].every((t) => hc.isPaneId(t))).toBe(true);
    expect(["w1:p2", "fix-login", "lead"].some((t) => hc.isPaneId(t))).toBe(false);
  });
});

describe("mux selection", () => {
  test("the Dori mode config picks the multiplexer; DORI_MUX overrides it; anything else is refused", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "dori-cfg-")), "config.json");
    writeFileSync(path, JSON.stringify({ mux: "hc" }));
    const saved = process.env["DORI_MUX"];
    try {
      delete process.env["DORI_MUX"];
      expect((await loadConfig(path)).mux).toBe("hc");
      process.env["DORI_MUX"] = "herdr";
      expect((await loadConfig(path)).mux).toBe("herdr");
      process.env["DORI_MUX"] = "tmux";
      await expect(loadConfig(path)).rejects.toThrow("mux must be");
    } finally {
      if (saved === undefined) delete process.env["DORI_MUX"];
      else process.env["DORI_MUX"] = saved;
    }
  });
});

describe("one dori command", () => {
  test("Dori mode commands, and send to a messenger, belong to the skill CLI; harness commands stay here", () => {
    for (const argv of [["watch"], ["dead-panes", "--loop", "3"], ["guard"], ["freshness"], ["can-launch"], ["launch", "k"], ["sync"], ["claim-done", "k"], ["object-done", "k"], ["close", "k"], ["send", "discord", "--to", "1"]]) {
      expect(isSkillCommand(argv)).toBe(true);
    }
    for (const argv of [["send", "lead", "--text", "hi"], ["send", "t3"], ["start", "k"], ["report", "k"], ["ready", "k"], ["done", "k"], ["status"], ["up"], ["duty"], ["duty-watch"], []]) {
      expect(isSkillCommand(argv)).toBe(false);
    }
  });

  test("the root CLI runs a forwarded command in the skill CLI with its exit code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dori-fwd-"));
    const config = join(dir, "config.json");
    writeFileSync(config, JSON.stringify({ mux: "hc", stateDir: join(dir, "state") }));
    const env: Record<string, string | undefined> = { ...process.env, DORI_CONFIG: config, DORI_HOME: join(dir, "harness"), DORI_TELEMETRY: "0", HC_TERMINAL_ID: "t999", HERDR_PANE_ID: "" };
    delete env["DORI_DISCORD_TOKEN"];
    delete env["DORI_MUX"];
    const cli = resolve(import.meta.dir, "../src/cli.ts");
    const runCli = async (...argv: string[]) => {
      const p = Bun.spawn(["bun", cli, ...argv], { env, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { out, err, code };
    };
    expect(await runCli("claim-done", "--evidence", "x")).toMatchObject({ code: 1, err: "no open lane is registered for this pane\n" });
    expect((await runCli("send", "discord", "--to", "1", "--text", "hi")).err).toContain("DORI_DISCORD_TOKEN is not set");
    const sendLead = await runCli("send", "lead", "--text", "hi");
    expect(sendLead).toMatchObject({ code: 2 });
    expect(sendLead.err).toContain("no lead pane");
    const watch = await runCli("duty-watch", "--loop", "0");
    expect(watch).toMatchObject({ code: 3, out: "DUTY_WATCH_READY\nDUTY_STALE no heartbeat yet; run: dori up\n" });
  });
});
