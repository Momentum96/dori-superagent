import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { statusOf } from "../skills/dori-mode/scripts/src/registry.ts";
import { Reports } from "../skills/dori-mode/scripts/src/reports.ts";
import { main } from "../src/cli.ts";
import { done, dutyTick, mergeGate, ready, Refusal, report, review, send, startLane } from "../src/harness.ts";
import { World } from "./fake.ts";

function setup() {
  const w = new World();
  const d = w.deps({ nudgeAfterMin: 10 });
  const lead = w.addPane("w1:p1", "idle");
  d.store.setRole("lead", "w1:p1");
  const brief = join(d.store.root, "brief.md");
  writeFileSync(brief, "Fix the flaky login test.");
  return { w, d, lead, brief };
}

describe("lanes", () => {
  test("start opens a tab, launches omo with the brief, and tells the lead", async () => {
    const { w, d, lead, brief } = setup();
    const { lane: lane } = await startLane(d, "fix-login", brief, { done: `file ${brief}` });
    const pane = w.panes.get(lane.pane!)!;
    expect(pane.ran[0]).toStartWith("omo --model");
    expect(await Bun.file(lane.brief).text()).toContain("claim-done fix-login --evidence");
    expect(lead.received).toEqual([expect.stringContaining(`[START fix-login] lane opened in ${lane.pane!}`)]);
    await expect(startLane(d, "fix-login", brief, { done: `file ${brief}` })).rejects.toThrow(Refusal);
  });

  test("start refuses the role names lead and duty as lane keys before it writes or opens anything", async () => {
    const { w, d, lead, brief } = setup();
    for (const key of ["lead", "duty"]) {
      await expect(startLane(d, key, brief, { done: `file ${brief}` })).rejects.toThrow(`lane key "${key}" is reserved for the ${key} role`);
      expect(await d.flow.registry.read(key)).toBeNull();
      expect(existsSync(d.flow.registry.path(key))).toBe(false);
    }
    expect(w.calls).toEqual([]);
    expect(lead.received).toEqual([]);
    expect(d.store.roles().lead).toBe("w1:p1");
  });

  test("ready requires evidence, then reaches the lead; done closes only a ready lane", async () => {
    const { w, d, lead, brief } = setup();
    const { lane: lane } = await startLane(d, "fix-login", brief, { done: `file ${brief}` });
    w.panes.get(lane.pane!)!.status = "working";
    await expect(done(d, "fix-login")).rejects.toThrow("working");
    w.panes.get(lane.pane!)!.status = "idle";
    await expect(ready(d, "fix-login", "fixed", [])).rejects.toThrow("evidence");
    await ready(d, "fix-login", "fixed", ["https://github.com/o/r/pull/1"]);
    expect(lead.received.at(-1)).toBe("[READY fix-login] fixed\nevidence: https://github.com/o/r/pull/1");
    expect(w.usage.map((e) => e.name)).toEqual(["dori.lane_started", "dori.lane_ready"]);
    expect(JSON.stringify(w.usage)).not.toContain("fix-login");
    await done(d, "fix-login");
    expect(w.panes.has(lane.pane!)).toBe(false);
    expect(statusOf((await d.flow.registry.read("fix-login"))!)).toBe("closed");
  });
});

describe("pane messaging", () => {
  test("a busy lead is never interrupted: messages queue and arrive as one batch when it goes idle", async () => {
    const { d, lead, brief } = setup();
    await startLane(d, "a-lane", brief, { done: `file ${brief}` });
    lead.received.length = 0;
    lead.status = "working";
    await report(d, "a-lane", "tests red, investigating");
    expect(await send(d, "lead", "second note", "a-lane")).toBe("QUEUED");
    expect(lead.received).toEqual([]);
    lead.status = "idle";
    const events = await dutyTick(d);
    expect(events).toContainEqual({ pane: "w1:p1", action: "flushed" });
    expect(lead.received).toHaveLength(1);
    expect(lead.received[0]).toContain("2 messages arrived while you were busy");
    expect(lead.received[0]).toContain("[REPORT] a-lane | milestone | tests red, investigating");
    expect(lead.received[0]).toContain("second note");
  });

  test("an omo pane that herdr refuses `agent prompt` for (agent_not_ready) still gets the text typed in", async () => {
    const { w, d, lead } = setup();
    w.promptFails.set("w1:p1", '{"error":{"code":"agent_not_ready"}}');
    expect(await send(d, "lead", "hello\n\nlead", "cli")).toBe("DELIVERED");
    expect(lead.received).toEqual(["hello / lead"]);
    expect(w.calls).toContainEqual({ cmd: "herdr", argv: ["pane", "send-keys", "w1:p1", "enter"] });
  });

  test("a failing Enter is retried without typing the text again; after 3 failures it is thrown", async () => {
    const { w, d, lead } = setup();
    const enters = () => w.calls.filter((c) => c.argv[1] === "send-keys").length;
    w.promptFails.set("w1:p1", '{"error":{"code":"agent_not_ready"}}');
    w.keyFails = 2;
    await d.mux.deliver("w1:p1", "once");
    expect(lead.received).toEqual(["once"]);
    expect(enters()).toBe(3);
    w.keyFails = 5;
    await expect(d.mux.deliver("w1:p1", "twice")).rejects.toThrow("key press failed");
    expect(lead.received).toEqual(["once", "twice"]);
    expect(enters()).toBe(6);
  });

  test("another `agent prompt` failure for a message that merely mentions agent_not_ready is still thrown", async () => {
    const { w, d, lead } = setup();
    w.promptFails.set("w1:p1", "herdr exploded");
    await expect(d.mux.deliver("w1:p1", "a lane quoted agent_not_ready here")).rejects.toThrow("herdr exploded");
    expect(lead.received).toEqual([]);
  });

  test("the typed fallback trims leading and trailing newlines instead of leaving a dangling ' / '", async () => {
    const { w, d, lead } = setup();
    w.promptFails.set("w1:p1", '{"error":{"code":"agent_not_ready"}}');
    await d.mux.deliver("w1:p1", "\n\nhello\nworld\n\n");
    expect(lead.received).toEqual(["hello / world"]);
  });

  test("agent_not_ready on a pane that is now a plain shell types nothing and reports not delivered", async () => {
    const { w, d } = setup();
    const shell = w.addPane("w1:p7", "shell");
    w.promptFails.set("w1:p7", '{"error":{"code":"agent_not_ready"}}');
    await expect(d.mux.deliver("w1:p7", "rm -rf nothing")).resolves.toBe(false);
    expect(shell.received).toEqual([]);
  });

  test("unknown targets are refused instead of guessed", async () => {
    const { d } = setup();
    await expect(send(d, "nobody", "hi", "cli")).rejects.toThrow("unknown target");
  });
});

describe("duty loop", () => {
  test("freshness nudges once at 10 minutes, escalates at 20, and ignores blocked reports", async () => {
    const { w, d, lead, brief } = setup();
    const { lane: lane } = await startLane(d, "quiet", brief, { done: `file ${brief}` });
    const pane = w.panes.get(lane.pane!)!;
    pane.status = "idle";
    const at = async (min: number) => { w.clock = Date.parse(lane.openedAt) + min * 60_000; return dutyTick(d); };
    expect(await at(5)).toEqual([]);
    expect(await at(10)).toContainEqual({ lane: "quiet", action: "freshness nudged" });
    expect(pane.received.at(-1)).toContain("your work thread has had no update");
    expect(await at(15)).toEqual([]);
    expect(await at(20)).toContainEqual({ lane: "quiet", action: "escalated" });
    expect(await at(40)).toEqual([]);
    expect(lead.received.at(-1)).toContain("[ESCALATE quiet]");
    expect(await at(90)).toEqual([]);

    const { lane: waiting } = await startLane(d, "blocked-on-ci", brief, { done: `file ${brief}` });
    w.panes.get(waiting.pane!)!.status = "idle";
    await report(d, "blocked-on-ci", "WAITING: CI", "blocker");
    w.clock += 60 * 60_000;
    expect((await dutyTick(d)).filter((e) => e.lane === "blocked-on-ci" && e.action.includes("nudged"))).toEqual([]);
    expect(w.panes.get(waiting.pane!)!.received).toEqual([]);
  });

  test("a failing inbox flush on one pane does not stop the loop for the other panes", async () => {
    const { w, d, lead } = setup();
    const broken = w.addPane("w1:p9", "idle");
    w.promptFails.set("w1:p9", "herdr exploded");
    d.store.enqueue("w1:p9", { at: w.clock, from: "cli", text: "to broken" });
    d.store.enqueue("w1:p1", { at: w.clock, from: "cli", text: "to lead" });
    const events = await dutyTick(d);
    expect(events).toContainEqual({ pane: "w1:p9", action: "flush-failed", detail: expect.stringContaining("herdr exploded") });
    expect(events).toContainEqual({ pane: "w1:p1", action: "flushed" });
    expect(lead.received).toEqual(["to lead"]);
    expect(broken.received).toEqual([]);
  });

  test("a failing lane-phase delivery is recorded as lane-failed and does not stop the other lanes", async () => {
    const { w, d, brief } = setup();
    const { lane: lost } = await startLane(d, "lost-lane", brief, { done: `file ${brief}` });
    const { lane: stuck } = await startLane(d, "stuck-lane", brief, { done: `file ${brief}` });
    const { lane: fine } = await startLane(d, "fine-lane", brief, { done: `file ${brief}` });
    w.panes.delete(lost.pane!);
    w.panes.get(stuck.pane!)!.status = "idle";
    w.panes.get(fine.pane!)!.status = "idle";
    w.promptFails.set("w1:p1", "lead exploded");
    w.promptFails.set(stuck.pane!, "stuck exploded");
    const run = d.flow.run;
    const isolated = { ...d, flow: { ...d.flow, run: async (...args: Parameters<typeof run>) => {
      if (args[0][1] === "pane" && args[0][2] === "send-text" && args[0][3] === stuck.pane) throw new Error("stuck exploded");
      return run(...args);
    } } };
    w.clock = Date.parse(fine.openedAt) + 10 * 60_000;
    const events = await dutyTick(isolated);
    expect(events).toContainEqual({ lane: "lost-lane", action: "lane-failed", detail: expect.stringContaining("lead exploded") });
    expect(events).toContainEqual({ lane: "stuck-lane", action: "lane-failed", detail: expect.stringContaining("stuck exploded") });
    expect(events).toContainEqual({ lane: "fine-lane", action: "freshness nudged" });
    expect(w.panes.get(fine.pane!)!.received.at(-1)).toContain("your work thread has had no update");
  });

  test("a LOST notice whose lead delivery failed once still reaches the lead on the next tick, exactly once", async () => {
    const { w, d, lead, brief } = setup();
    const { lane: gone } = await startLane(d, "gone-lane", brief, { done: `file ${brief}` });
    lead.received.length = 0;
    w.panes.delete(gone.pane!);
    w.promptFails.set("w1:p1", "lead exploded");
    expect(await dutyTick(d)).toContainEqual({ lane: "gone-lane", action: "lane-failed", detail: expect.stringContaining("lead exploded") });
    expect(lead.received).toEqual([]);
    w.promptFails.delete("w1:p1");
    const events = await dutyTick(d);
    expect(events).toContainEqual({ pane: "w1:p1", action: "flushed" });
    expect(lead.received.filter((m) => m.includes("[LOST gone-lane]"))).toHaveLength(1);
    expect(await dutyTick(d)).toEqual([]);
    expect(lead.received.filter((m) => m.includes("[LOST gone-lane]"))).toHaveLength(1);
  });

  test("the flush-failed detail is herdr's first output line, never the queued message", async () => {
    const { w, d } = setup();
    w.addPane("w1:p9", "idle");
    w.promptFails.set("w1:p9", "herdr exploded\nsecond line");
    d.store.enqueue("w1:p9", { at: w.clock, from: "cli", text: "SECRET queued message" });
    const events = await dutyTick(d);
    expect(events).toEqual([{ pane: "w1:p9", action: "flush-failed", detail: "herdr exploded" }]);
  });

  test("the duty loop prints a flush-failed line with the reason", async () => {
    const { w, d } = setup();
    w.addPane("w1:p9", "idle");
    w.promptFails.set("w1:p9", "herdr exploded");
    d.store.enqueue("w1:p9", { at: w.clock, from: "cli", text: "to broken" });
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      expect(await main(["duty", "--once"], d)).toBe(0);
    } finally {
      console.log = log;
    }
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("DUTY_LOOP_READY");
    expect(lines[1]).toStartWith("DUTY w1:p9 flush-failed: ");
    expect(lines[1]).toContain("herdr exploded");
  });

  test("kill switch: a stopped duty loop flushes, nudges and escalates nothing; resume delivers what was held", async () => {
    const { w, d, lead, brief } = setup();
    const { lane: lane } = await startLane(d, "quiet", brief, { done: `file ${brief}` });
    w.panes.get(lane.pane!)!.status = "idle";
    lead.status = "working";
    expect(await send(d, "lead", "held note", "cli")).toBe("QUEUED");
    lead.status = "idle";
    lead.received.length = 0;
    w.clock = Date.parse(lane.openedAt) + 40 * 60_000;
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      expect(await main(["duty", "stop", "--text", "maintenance"], d)).toBe(0);
      expect(await main(["duty", "--once"], d)).toBe(0);
      expect(await main(["duty", "status"], d)).toBe(0);
    } finally {
      console.log = log;
    }
    expect(lines).toEqual(["DUTY STOPPED", "DUTY_LOOP_READY", "DUTY stopped: maintenance", "stopped: maintenance"]);
    expect(lead.received).toEqual([]);
    expect((await d.flow.registry.read("quiet"))!.lastNudgeAt).toBeUndefined();
    expect(d.store.heartbeat()?.at).toBe(w.clock);
    expect(d.store.stop()).toBeUndefined();
    expect(w.dutyCounts).toEqual([]);

    await main(["duty", "resume"], d);
    const events = await dutyTick(d);
    expect(events).toContainEqual({ pane: "w1:p1", action: "flushed" });
    expect(events).toContainEqual({ lane: "quiet", action: "freshness nudged" });
    expect(lead.received).toEqual(["held note"]);
  });

  test("a working pane does not fabricate a report; freshness owns nudges and a vanished pane is LOST", async () => {
    const { w, d, lead, brief } = setup();
    const { lane: lane } = await startLane(d, "busy", brief, { done: `file ${brief}` });
    w.panes.get(lane.pane!)!.status = "working";
    w.clock += 30 * 60_000;
    expect(await dutyTick(d)).toContainEqual({ lane: "busy", action: "freshness nudged" });
    expect(new Reports(d.flow.config.stateDir).read("busy")?.lastReport).toBeNull();
    expect(w.touches).toBeGreaterThan(0);
    w.panes.delete(lane.pane!);
    expect(await dutyTick(d)).toContainEqual({ lane: "busy", action: "lost" });
    expect(lead.received.at(-1)).toContain("[LOST busy]");
  });
});

describe("review + merge gate", () => {
  const head = "a".repeat(40);
  function gh(w: World, checks: unknown[]) {
    w.gh = (argv) => {
      if (argv[1] === "view") return { code: 0, stdout: JSON.stringify({ headRefOid: head }) };
      if (argv[1] === "checks") return { code: 0, stdout: JSON.stringify(checks) };
      if (argv[1] === "merge") return { code: 0, stdout: "" };
      return { code: 1, stdout: "" };
    };
  }

  test("merge is refused without a receipt, with an empty check list, with red checks; allowed at CLEAR + green", async () => {
    const { w, d } = setup();
    gh(w, []);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("no review receipt");
    w.reviewer = () => ({ code: 0, stdout: "HIGH src/a.ts:3 ...\nVERDICT: BLOCK" });
    expect((await review(d, "o/r#7")).verdict).toBe("BLOCK");
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("is BLOCK");
    w.reviewer = () => ({ code: 0, stdout: "no findings\nVERDICT: CLEAR" });
    await review(d, "o/r#7", "some/model");
    expect(d.store.receipt("o/r#7", head)!.model).toBe("some/model");
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("never green");
    gh(w, [{ name: "test", bucket: "fail" }, { name: "lint", bucket: "pass" }]);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("test=fail");
    gh(w, [{ name: "test", bucket: "skipping" }]);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("every check was skipped");
    gh(w, [{ name: "test", bucket: "pass" }, { name: "docs", bucket: "skipping" }]);
    expect(await mergeGate(d, "o/r#7")).toBe(`MERGED o/r#7 head=${head}`);
    expect(w.calls.at(-1)!.argv).toContain("--match-head-commit");
    expect(w.usage.filter((e) => e.name === "dori.merge_decided").map((e) => (e as { outcome: string }).outcome))
      .toEqual(["no_receipt", "review_block", "no_checks", "checks_red", "checks_all_skipped", "merged"]);
    expect(w.usage.filter((e) => e.name === "dori.review_completed")).toHaveLength(2);
  });

  test("a reviewer without a VERDICT line writes no receipt", async () => {
    const { w, d } = setup();
    gh(w, []);
    w.reviewer = () => ({ code: 0, stdout: "looks fine I guess" });
    await expect(review(d, "o/r#8")).rejects.toThrow("no VERDICT");
    expect(d.store.receipt("o/r#8", head)).toBeUndefined();
  });
});
