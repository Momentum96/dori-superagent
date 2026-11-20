import { afterEach, beforeEach, expect, test } from "bun:test";

import { WAKE } from "../src/lead-pump-text.ts";
import { withState } from "./fakes.ts";
import { hcTerm } from "./hc-runner.ts";
import { LEAD, makeRig, type Rig } from "./lead-pump-rig.ts";

let state: ReturnType<typeof withState>;
let rig: Rig;
beforeEach(() => {
  state = withState();
  rig = makeRig(state.dir);
});
afterEach(() => {
  rig.inbox.close();
  state.done();
});

test("T2.1 an idle lead and one item: one prompt, no steer, the token in the transcript once", async () => {
  rig.put("d:1", "hello", { channel: "c1", message: "m1" });
  await rig.pump().tick();
  expect(rig.texts("prompt")).toHaveLength(1);
  expect(rig.texts("steer")).toHaveLength(0);
  const transcript = JSON.stringify(rig.host.sessions.get(LEAD)?.entries);
  expect(transcript.split("[INBOX#d:1] ").length - 1).toBe(1);
  expect(rig.inbox.list("done").map((i) => [i.id, i.accepted, i.generation])).toEqual([["d:1", 1, 1]]);
  expect(rig.hooks).toEqual([["react", "d:1", "c1", "m1"]]);
});

test("T2.2 a working lead gets one steer and no prompt", async () => {
  rig.working(true);
  rig.put("r:mac:lane:0");
  await rig.pump().tick();
  expect(rig.texts("steer")).toHaveLength(1);
  expect(rig.texts("prompt")).toHaveLength(0);
  expect(rig.inbox.stats().done).toBe(1);
});

test("a busy refusal leaves the item queued with no attempt counted; the next tick delivers it", async () => {
  rig.working(true);
  rig.host.refuseNext.set("steer", "busy");
  rig.put("d:1");
  const pump = rig.pump();
  await pump.tick();
  expect(rig.inbox.list("queued").map((i) => [i.id, i.attempts])).toEqual([["d:1", 0]]);
  rig.clock.at += 2_000;
  await pump.tick();
  expect(rig.inbox.list("done").map((i) => [i.id, i.attempts])).toEqual([["d:1", 1]]);
  expect(rig.health()["inbox"]?.["lastError"]).toBeNull();
});

test("T2.3 a steer that lands after the turn ended: one wake prompt, the item never sent again", async () => {
  rig.working(true);
  rig.setBefore((argv) => {
    if (argv.includes("steer")) rig.working(false);
  });
  rig.put("d:1");
  const pump = rig.pump();
  await pump.tick();
  rig.clock.at += 2_000;
  await pump.tick();
  expect(rig.texts("prompt")).toEqual([WAKE]);
  expect(rig.sends("d:1")).toBe(1);
  expect(rig.inbox.list("done").map((i) => i.id)).toEqual(["d:1"]);
});

test("T2.4 A1 A2 B1 A3 to a working lead: one steer, the bodies in arrival order", async () => {
  rig.working(true);
  for (const id of ["r:m:a:1", "r:m:a:2", "r:m:b:1", "r:m:a:3"]) rig.put(id);
  await rig.pump().tick();
  const [text = ""] = rig.texts("steer");
  expect(rig.texts("steer")).toHaveLength(1);
  const at = ["a:1", "a:2", "b:1", "a:3"].map((k) => text.indexOf(`[INBOX#r:m:${k}] `));
  expect(at.every((n) => n >= 0)).toBe(true);
  expect([...at].sort((x, y) => x - y)).toEqual(at);
});

test("T2.5 host_unavailable twice, then back with a new pid: one sys:host-restart, then the item exactly once", async () => {
  const pump = rig.pump();
  await pump.tick();
  rig.host.down = true;
  rig.put("d:1");
  rig.clock.at += 2_000;
  await pump.tick();
  rig.clock.at += 4_000;
  await pump.tick();
  const statusCalls = (): number => rig.host.calls.filter((c) => c[0] === "status").length;
  expect(statusCalls()).toBe(2);
  rig.clock.at += 1_000;
  await pump.tick();
  expect(statusCalls()).toBe(3);
  rig.clock.at += 14_000;
  await pump.tick();
  expect(statusCalls()).toBe(3);
  rig.host.down = false;
  rig.host.status = { pid: 5151, processStartTime: "Sat Nov 21 02:00:20 2026 UTC" };
  rig.clock.at += 2_000;
  await pump.tick();
  const [text = ""] = rig.texts("prompt");
  expect(rig.texts("prompt")).toHaveLength(1);
  expect(text.indexOf("[INBOX#sys:host-restart:2026-11-21T02:00:20.000Z] ")).toBe(0);
  expect(text.indexOf("[INBOX#d:1] ")).toBeGreaterThan(0);
  expect(rig.sends("d:1")).toBe(1);
  rig.clock.at += 2_000;
  await pump.tick();
  expect(rig.sends("d:1")).toBe(1);
});

test("T2.6 generation 7 to 8: no call names the old id, only the last 10 minutes are replayed", async () => {
  const NEW = "01a1f9b4-9158-791d-b728-6a14be98958d";
  rig.writeLead({ generation: 7 });
  const pump = rig.pump();
  rig.put("d:old");
  await pump.tick();
  rig.working(false);
  rig.clock.at += 11 * 60_000;
  rig.put("d:recent");
  await pump.tick();
  rig.host.add({ id: NEW, name: "dori-lead-omo", cwd: "/lead" });
  rig.writeLead({ generation: 8, sessionId: NEW, retired: [LEAD] });
  const before = rig.host.calls.length;
  rig.clock.at += 60_000;
  await pump.tick();
  const after = rig.host.calls.slice(before);
  expect(after.some((c) => c.includes(LEAD))).toBe(false);
  const text = after.find((c) => c[0] === "prompt")?.[2] ?? "";
  expect(text.indexOf("[INBOX#sys:lead-replaced:8] ")).toBe(0);
  expect(text).toContain("[INBOX#d:recent] kind=report source=lane-x replayed=true");
  expect(text).not.toContain("d:old");
  expect(rig.inbox.list("done").find((i) => i.id === "d:recent")?.generation).toBe(8);
});

test("a lead.json whose active id is in retired: the tick throws and nothing reaches the host", async () => {
  rig.writeLead({ retired: [LEAD] });
  rig.put("d:1");
  await expect(rig.pump().tick()).rejects.toThrow(/retired session/);
  expect(rig.host.calls).toEqual([]);
  expect(rig.inbox.stats().queued).toBe(1);
});

test("switching: no runtime call; an item queued over 4 minutes reports the lead stuck", async () => {
  rig.writeLead({ state: "switching" });
  rig.put("d:1");
  const pump = rig.pump();
  await pump.tick();
  rig.clock.at += 4 * 60_000 + 1_000;
  await pump.tick();
  expect(rig.host.calls).toEqual([]);
  expect(rig.health()["lead"]).toMatchObject({ stuck: true });
  expect(rig.health()["inbox"]).toMatchObject({ queued: 1, oldestQueuedSec: 241 });
});

test("an hc lead is fed through the hc adapter and the omo host is never called", async () => {
  rig.hc.terminals["t7"] = hcTerm();
  rig.writeLead({ runtime: "hc", sessionId: "t7" });
  rig.put("d:1");
  await rig.pump().tick();
  const sends = rig.runs.filter((r) => r.argv[0] === "hc" && r.argv.includes("send"));
  expect(sends).toHaveLength(1);
  expect(sends[0]?.argv.at(-1)).toContain("[INBOX#d:1] ");
  expect(rig.host.calls).toEqual([]);
  expect(rig.health()["host"]).toBeNull();
});
