import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { statusOf } from "../skills/dori-mode/scripts/src/registry.ts";
import {
  done, dutyTick, dutyWatchTick, mergeGate, newDutyMemory, ready, Refusal, report, review, send, startLane, up,
} from "../src/harness.ts";
import { World } from "./fake.ts";

const MIN = 60_000;

function setup(patch: Parameters<World["deps"]>[0] = {}) {
  const w = new World();
  const d = w.deps({ leadPane: "w1:p1", ...patch });
  const lead = w.addPane("w1:p1", "idle");
  const brief = join(d.store.root, "brief.md");
  writeFileSync(brief, "Fix the flaky login test.");
  const open = (key: string, extra: { done?: string; thread?: string } = {}) =>
    startLane(d, key, brief, { done: extra.done ?? `file ${brief}`, thread: extra.thread ?? "discord:42" });
  return { w, d, lead, brief, open };
}

describe("one lane registry", () => {
  test("start is Dori mode's launch: a registry lane with the lane footer and agent command, then [START] to the config's lead", async () => {
    const { w, d, lead, brief, open } = setup();
    const { lane } = await open("fix-login");
    expect(await d.flow.registry.read("fix-login")).toMatchObject({ key: "fix-login", pane: lane.pane, thread: "discord:42", done: `file ${brief}` });
    expect(await Bun.file(brief).text()).toContain("dori report fix-login --kind");
    expect(w.panes.get(lane.pane!)!.ran[0]).toStartWith("omo --model");
    expect(lead.received[0]).toStartWith(`[START fix-login] lane opened in ${lane.pane}`);
    await expect(open("fix-login")).rejects.toThrow(Refusal);
  });

  test("report records the line and the quiet clock; freshness posts it to the thread from the record, with a blank screen", async () => {
    const { w, d, lead, open } = setup();
    const { lane } = await open("quiet");
    const line = await report(d, "quiet", "repro found, fixing", "milestone");
    expect(line).toBe("[REPORT] quiet | milestone | repro found, fixing");
    expect(lead.received.at(-1)).toBe(line);
    expect(await d.flow.registry.read("quiet")).toMatchObject({ lastReport: line, lastReplyAt: w.clock });
    expect(w.panes.get(lane.pane!)!.screen).toBe("");
    w.clock += 25 * MIN;
    const events = await dutyTick(d);
    expect(events).toContainEqual({ lane: "quiet", action: "freshness posted" });
    expect(w.posts()).toEqual([["discord:42", "Progress (from the lane's last report): repro found, fixing"]]);
    await expect(report(d, "quiet", "x", "progress")).rejects.toThrow("--kind");
  });

  test("ready is a done claim with the final answer; done closes only when every Done signal reads back live", async () => {
    const { w, d, lead, open } = setup();
    const { lane } = await open("fix-login");
    await expect(ready(d, "fix-login", "fixed", [])).rejects.toThrow("evidence");
    expect(await ready(d, "fix-login", "fixed", ["https://github.com/o/r/pull/1"])).toStartWith("LANE_DONE_CLAIMED fix-login");
    const claimed = (await d.flow.registry.read("fix-login"))!;
    expect(statusOf(claimed)).toBe("done-claimed");
    expect(claimed.claim!.evidence).toBe("fixed | evidence: https://github.com/o/r/pull/1");
    expect(lead.received.at(-1)).toBe("[READY fix-login] fixed\nevidence: https://github.com/o/r/pull/1");
    expect((await done(d, "fix-login")).at(-1)).toStartWith("CLOSED fix-login");
    expect(w.panes.has(lane.pane!)).toBe(false);
    expect(statusOf((await d.flow.registry.read("fix-login"))!)).toBe("closed");

    await open("not-yet", { done: "file /nonexistent/dori-result.txt" });
    await expect(done(d, "not-yet")).rejects.toThrow("REFUSED not-yet");
  });
});

describe("pane messaging", () => {
  test("a busy lead is never interrupted: messages queue and arrive as one batch when it goes idle", async () => {
    const { d, lead, open } = setup();
    await open("a-lane");
    lead.received.length = 0;
    lead.status = "working";
    await report(d, "a-lane", "tests red, investigating");
    expect(await send(d, "lead", "second note", "a-lane")).toBe("QUEUED");
    expect(lead.received).toEqual([]);
    lead.status = "idle";
    expect(await dutyTick(d)).toContainEqual({ pane: "w1:p1", action: "flushed" });
    expect(lead.received).toHaveLength(1);
    expect(lead.received[0]).toContain("2 messages arrived while you were busy");
    expect(lead.received[0]).toContain("[REPORT] a-lane | milestone | tests red, investigating");
  });

  test("unknown targets are refused instead of guessed; roles.json overrides the config's lead", async () => {
    const { w, d } = setup();
    await expect(send(d, "nobody", "hi", "cli")).rejects.toThrow("unknown target");
    const other = w.addPane("w1:p9", "idle");
    d.store.setRole("lead", "w1:p9");
    await send(d, "lead", "hi", "cli");
    expect(other.received).toEqual(["hi"]);
  });
});

describe("duty loop", () => {
  test("freshness is the only nudger: one nudge, then one [ESCALATE] to the lead, and a vanished pane is [LOST] once", async () => {
    const { w, d, lead, open } = setup({ nudgeAfterMin: 15 });
    const { lane } = await open("silent");
    const pane = w.panes.get(lane.pane!)!;
    const mem = newDutyMemory();
    w.clock += 16 * MIN;
    expect(await dutyTick(d, mem)).toContainEqual({ lane: "silent", action: "freshness nudged" });
    expect(pane.received).toHaveLength(1);
    expect(pane.received[0]).toStartWith("[LEAD] your work thread has had no update");
    w.clock += 16 * MIN;
    expect(await dutyTick(d, mem)).toContainEqual({ lane: "silent", action: "escalated" });
    expect(lead.received.at(-1)).toStartWith("[ESCALATE silent]");
    w.clock += 16 * MIN;
    expect((await dutyTick(d, mem)).filter((e) => e.lane === "silent")).toEqual([]);
    expect(pane.received).toHaveLength(1);

    w.panes.delete(lane.pane!);
    expect(await dutyTick(d, mem)).toContainEqual({ lane: "silent", action: "lost" });
    expect(lead.received.at(-1)).toStartWith("[LOST silent]");
    expect((await dutyTick(d, mem)).filter((e) => e.action === "lost")).toEqual([]);
  });

  test("a dead lane pane goes to the duty session; the duty session and loop panes are never swept", async () => {
    const { w, d, open } = setup();
    const duty = w.addPane("w1:p50", "idle");
    w.addPane("w1:p51", "shell");
    d.store.setRole("duty", "w1:p50");
    d.store.setRole("duty-loop", "w1:p51");
    const { lane } = await open("crashed");
    const pane = w.panes.get(lane.pane!)!;
    pane.status = "shell";
    pane.screen = "omo has stopped";
    const mem = newDutyMemory();
    const all = [...(await dutyTick(d, mem)), ...(await dutyTick(d, mem)), ...(await dutyTick(d, mem))];
    expect(all).toContainEqual({ pane: lane.pane, action: "dead_pane" });
    expect(all.filter((e) => e.pane === "w1:p50" || e.pane === "w1:p51")).toEqual([]);
    expect(duty.received.some((m) => m.startsWith(`[DEAD_PANE ${lane.pane}]`))).toBe(true);
  });

  test("every pass writes a heartbeat; duty-watch says DUTY_STALE once when it stops and DUTY_OK when it is back", async () => {
    const { w, d } = setup();
    const state = { stale: false };
    expect(dutyWatchTick(d, 3 * MIN, state)).toBe("DUTY_STALE no heartbeat yet; run: dori up");
    await dutyTick(d, newDutyMemory(60_000));
    expect(d.store.heartbeat()).toMatchObject({ at: w.clock, intervalMs: 60_000 });
    expect(dutyWatchTick(d, 3 * MIN, state)).toBe("DUTY_OK beat 0 s ago");
    w.clock += 4 * MIN;
    expect(dutyWatchTick(d, 3 * MIN, state)).toStartWith("DUTY_STALE last beat 4 min ago");
    expect(dutyWatchTick(d, 3 * MIN, state)).toBeNull();
  });

  test("a failing step does not stop the pass or the heartbeat", async () => {
    const { w, d } = setup();
    const broken = { ...d, flow: { ...d.flow, registry: { ...d.flow.registry, open: async () => { throw new Error("disk gone"); } } as unknown as typeof d.flow.registry } };
    const events = await dutyTick(broken);
    expect(events.some((e) => e.action.startsWith("error lanes: disk gone"))).toBe(true);
    expect(d.store.heartbeat()?.at).toBe(w.clock);
  });
});

describe("dori up", () => {
  test("never starts a second lead; starts duty and loop once; revives only what died", async () => {
    const { w, d, lead } = setup();
    const before = w.panes.size;
    const first = await up(d, "/repo");
    expect(first[0]).toBe("LEAD w1:p1 idle");
    const dutyPane = d.store.roles().duty!;
    const loopPane = d.store.roles()["duty-loop"]!;
    expect(w.panes.get(dutyPane)!.ran[0]).toMatch(/^omo --append-system-prompt .*duty\.md'$/);
    expect(w.panes.get(loopPane)!.ran[0]).toBe("dori duty --interval 60");
    expect(w.panes.size).toBe(before + 2);

    expect(await up(d, "/repo")).toEqual(["LEAD w1:p1 idle", `DUTY ${dutyPane} idle`, "LOOP alive, beat 0 s ago"]);
    expect(w.panes.size).toBe(before + 2);

    lead.status = "idle";
    w.panes.delete("w1:p1");
    w.panes.get(dutyPane)!.status = "shell";
    w.clock += 4 * MIN;
    const revived = await up(d, "/repo");
    expect(revived[0]).toContain("not starting another lead");
    expect(revived[1]).toBe(`DUTY restarted in ${dutyPane}`);
    expect(revived[2]).toStartWith(`LOOP started `);
    expect(revived[2]).toContain(`(replaced ${loopPane})`);
    expect(w.panes.has(loopPane)).toBe(false);
    expect(w.calls.filter((c) => c.argv[0] === "workspace")).toEqual([]);
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
  });

  test("a reviewer without a VERDICT line writes no receipt", async () => {
    const { w, d } = setup();
    gh(w, []);
    w.reviewer = () => ({ code: 0, stdout: "looks fine I guess" });
    await expect(review(d, "o/r#8")).rejects.toThrow("no VERDICT");
    expect(d.store.receipt("o/r#8", head)).toBeUndefined();
  });
});
