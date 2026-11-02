import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isSkillCommand } from "../src/cli.ts";
import { done, dutyTick, ready, send, startLane, type Deps } from "../src/harness.ts";
import { Hc } from "../src/hc.ts";
import type { Exec } from "../src/herdr.ts";
import { muxSettings } from "../src/mux.ts";
import { Store } from "../src/store.ts";

type Term = { state: "live" | "finished"; status: { app: string; state: string } | null; labels: Record<string, string>; argv: string[]; received: string[] };

class HcWorld {
  terms = new Map<string, Term>();
  calls: string[][] = [];
  next = 10;

  add(address: string, state: string | null): Term {
    const t: Term = { state: "live", status: state ? { app: "omo", state } : null, labels: {}, argv: [], received: [] };
    this.terms.set(address, t);
    return t;
  }

  exec: Exec = async (cmd, argv) => {
    this.calls.push([cmd, ...argv]);
    const ok = (out: unknown = "") => ({ code: 0, stdout: typeof out === "string" ? out : JSON.stringify(out), stderr: "" });
    const [verb, address = ""] = argv;
    if (verb === "run") {
      const t = this.add(`t${++this.next}`, null);
      for (let i = 0; i < argv.length; i++) if (argv[i] === "--label") { const [k, v] = argv[i + 1]!.split("="); t.labels[k!] = v!; }
      const envAt = argv.indexOf("env");
      t.argv = envAt >= 0 ? argv.slice(envAt) : [];
      return ok({ address: `t${this.next}`, state: "live" });
    }
    const t = this.terms.get(address);
    if (!t) return { code: 3, stdout: "", stderr: JSON.stringify({ error: { kind: "not_found", message: `no terminal ${address}` } }) };
    if (verb === "get") return ok({ address, state: t.state, status: t.status, labels: t.labels });
    if (verb === "send") { t.received.push(argv[2]!); return ok({ sent: true }); }
    if (verb === "read") return ok(t.received.join("\n"));
    if (verb === "kill") { t.state = "finished"; return ok(); }
    if (verb === "wait") return ok();
    if (verb === "rm") { this.terms.delete(address); return ok(); }
    return { code: 1, stdout: "", stderr: `unhandled ${argv.join(" ")}` };
  };

  deps(space?: string): Deps {
    return { store: new Store(mkdtempSync(join(tmpdir(), "dori-hc-test-"))), mux: new Hc(this.exec, space, "/bin/zsh"), exec: this.exec, now: () => 1_000_000, agentCmd: "omo", doriCmd: "dori" };
  }
}

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

  test("a lane opens as a named terminal in the configured space, with env through `env`, and reaches the lead by hc send", async () => {
    const w = new HcWorld();
    const d = w.deps("sp1");
    const lead = w.add("t3", "idle");
    d.store.setRole("lead", "t3");
    const brief = join(d.store.root, "brief.md");
    writeFileSync(brief, "Fix the flaky login test.");
    const lane = await startLane(d, "fix-login", brief, { cwd: "/repo" });
    expect(lane.paneId).toBe("t11");
    expect(w.calls[0]).toEqual([
      "hc", "run", "--bg", "--json", "--outlive-parent", "--no-notify", "--cwd", "/repo", "--name", "fix-login",
      "--label", "herdr.space=sp1", "--label", "dori.tab=fix-login",
      "env", "DORI_LANE=fix-login", `DORI_HOME=${d.store.root}`, "DORI_MUX=hc", "/bin/zsh", "-l",
    ]);
    expect(w.terms.get("t11")!.received[0]).toStartWith("omo 'Read your brief at ");
    expect(lead.received).toEqual(["[START fix-login] lane opened in t11"]);
  });

  test("a busy lead gets queued messages once hc reports it idle; done kills and removes the lane terminal", async () => {
    const w = new HcWorld();
    const d = w.deps();
    const lead = w.add("t3", "working");
    d.store.setRole("lead", "t3");
    const brief = join(d.store.root, "brief.md");
    writeFileSync(brief, "x");
    const lane = await startLane(d, "a-lane", brief, { cwd: "/repo" });
    expect(await send(d, "lead", "note", "a-lane")).toBe("QUEUED");
    expect(lead.received).toEqual([]);
    lead.status = { app: "omo", state: "idle" };
    expect(await dutyTick(d)).toContainEqual({ pane: "t3", action: "flushed" });
    expect(lead.received[0]).toContain("2 messages arrived while you were busy");
    await ready(d, "a-lane", "fixed", ["https://example.invalid/pr/1"]);
    await done(d, "a-lane");
    expect(w.terms.has(lane.paneId)).toBe(false);
    expect(w.calls.filter((c) => c[2] === lane.paneId && ["kill", "rm"].includes(c[1]!)).map((c) => c[1])).toEqual(["kill", "rm"]);
  });

  test("without a configured space a lane opens as one top-level terminal, never an extra workspace shell", async () => {
    const w = new HcWorld();
    const d = w.deps();
    const brief = join(d.store.root, "brief.md");
    writeFileSync(brief, "x");
    await startLane(d, "solo", brief, { cwd: "/repo" });
    const runs = w.calls.filter((c) => c[1] === "run");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.some((a) => a.startsWith("herdr.space="))).toBe(false);
    expect(runs[0]).toContain("dori.tab=solo");
  });

  test("hc addresses are pane ids for dori send; herdr ids and lane keys are not", () => {
    const hc = new Hc(new HcWorld().exec);
    expect(["t3", "t1b", "macmini/t7"].every((t) => hc.isPaneId(t))).toBe(true);
    expect(["w1:p2", "fix-login", "lead"].some((t) => hc.isPaneId(t))).toBe(false);
  });
});

describe("mux selection", () => {
  const cfg = (body: unknown) => {
    const p = join(mkdtempSync(join(tmpdir(), "dori-cfg-")), "config.json");
    writeFileSync(p, JSON.stringify(body));
    return p;
  };

  test("DORI_MUX wins over the config file; the config's mux and laneWorkspace apply otherwise; default is herdr", () => {
    const path = cfg({ mux: "hc", laneWorkspace: "sp9" });
    expect(muxSettings({ DORI_CONFIG: path })).toEqual({ kind: "hc", space: "sp9" });
    expect(muxSettings({ DORI_CONFIG: path, DORI_MUX: "herdr" })).toEqual({ kind: "herdr", space: "sp9" });
    expect(muxSettings({ DORI_CONFIG: join(tmpdir(), "no-such-dori-config.json") })).toEqual({ kind: "herdr" });
    expect(() => muxSettings({ DORI_CONFIG: path, DORI_MUX: "tmux" })).toThrow("mux must be");
  });
});

describe("one dori command", () => {
  test("Dori mode commands, and send to a messenger, belong to the skill CLI; harness commands stay here", () => {
    for (const argv of [["watch"], ["dead-panes", "--loop", "3"], ["guard"], ["freshness"], ["can-launch"], ["launch", "k"], ["sync"], ["claim-done", "k"], ["object-done", "k"], ["close", "k"], ["send", "discord", "--to", "1"]]) {
      expect(isSkillCommand(argv)).toBe(true);
    }
    for (const argv of [["send", "lead", "--text", "hi"], ["send", "t3"], ["start", "k"], ["done", "k"], ["status"], ["up"], []]) {
      expect(isSkillCommand(argv)).toBe(false);
    }
  });

  test("the root CLI runs a forwarded command in the skill CLI with its exit code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dori-fwd-"));
    const config = join(dir, "config.json");
    writeFileSync(config, JSON.stringify({ mux: "hc", stateDir: join(dir, "state") }));
    const env: Record<string, string | undefined> = { ...process.env, DORI_CONFIG: config, DORI_HOME: join(dir, "harness"), HC_TERMINAL_ID: "t999", HERDR_PANE_ID: "" };
    delete env["DORI_DISCORD_TOKEN"];
    delete env["DORI_MUX"];
    const cli = resolve(import.meta.dir, "../src/cli.ts");
    const runCli = async (...argv: string[]) => {
      const p = Bun.spawn(["bun", cli, ...argv], { env, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { out, err, code };
    };
    const claim = await runCli("claim-done", "--evidence", "x");
    expect(claim).toMatchObject({ code: 1, err: "no open lane is registered for this pane\n" });
    const sendDiscord = await runCli("send", "discord", "--to", "1", "--text", "hi");
    expect(sendDiscord.err).toContain("DORI_DISCORD_TOKEN is not set");
    const sendLead = await runCli("send", "lead", "--text", "hi");
    expect(sendLead).toMatchObject({ code: 2 });
    expect(sendLead.err).toContain("no lead pane registered");
  });
});
