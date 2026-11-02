import { expect, test } from "bun:test";

import { hcRunner } from "../src/hc-runner.ts";
import { listPanes, readScreen, sendVerified } from "../src/panes.ts";
import type { Ran, Runner } from "../src/run.ts";
import { fakeClock } from "./fakes.ts";

const ok = (out: unknown = ""): Ran => ({ code: 0, out: typeof out === "string" ? out : JSON.stringify(out), err: "" });

type Hc = { calls: string[][]; lane: { status: string | null }; screen: string };

const fakeHc = (w: Hc): Runner => async (argv) => {
  w.calls.push([...argv]);
  const [, verb, target] = argv;
  if (verb === "ls") return ok({ terminals: [
    { address: "t1", agent: "omo", status: "idle", cwd: "/a" },
    { address: "t4", agent: "omo", status: w.lane.status, cwd: "/repo" },
    { address: "t6", cwd: "/tmp" },
    { address: "macmini/t1", agent: "omo", status: "idle", cwd: "/b" },
  ] });
  if (verb === "get" && target === "t1") return ok({ pid: 11, title: "omo - lead", labels: { "herdr.space": "sp1", "herdr.tab": "tb1" }, foreground: { name: "omo" } });
  if (verb === "get" && target === "t4") return ok({ pid: 44, name: "demo", labels: { "herdr.space": "sp1", "dori.lane": "demo" }, foreground: { name: "omo" } });
  if (verb === "get" && target === "t6") return ok({ pid: 66, labels: {}, foreground: { name: "zsh" } });
  if (verb === "run") return ok({ address: "t9", state: "live" });
  if (verb === "read") return ok(`line1\nline2\n${w.screen}\n\n`);
  if (verb === "send") w.lane.status = "working";
  return ok();
};

const world = (status: string | null = "idle"): Hc => ({ calls: [], lane: { status }, screen: "❯ " });

test("pane list maps local hc terminals to herdr panes with space, tab, agent and hc's agent status", async () => {
  const panes = await listPanes(hcRunner(fakeHc(world())));
  expect(panes).toEqual([
    { pane_id: "t1", workspace_id: "sp1", tab_id: "tb1", agent: "omo", agent_status: "idle", title: "omo - lead", cwd: "/a" },
    { pane_id: "t4", workspace_id: "sp1", agent: "omo", agent_status: "idle", title: "demo", cwd: "/repo" },
    { pane_id: "t6", workspace_id: "", title: "t6", cwd: "/tmp" },
  ]);
});

test("a terminal hc reports no status for keeps its agent but has no agent_status", async () => {
  const panes = await listPanes(hcRunner(fakeHc(world(null))));
  expect(panes.find((p) => p.pane_id === "t4")).toEqual({ pane_id: "t4", workspace_id: "sp1", agent: "omo", title: "demo", cwd: "/repo" });
});

test("tab create starts a labelled login shell that outlives the lead, and pane run types the command", async () => {
  const w = world();
  const run = hcRunner(fakeHc(w));
  const made = await run(["herdr", "tab", "create", "--workspace", "sp1", "--cwd", "/repo", "--label", "demo-lane", "--no-focus"]);
  expect(JSON.parse(made.out)).toEqual({ result: { root_pane: { pane_id: "t9" } } });
  expect(w.calls[0]).toEqual(["hc", "run", "--bg", "--json", "--outlive-parent", "--no-notify", "--name", "demo-lane", "--cwd", "/repo", "--label", "herdr.space=sp1", "--label", "dori.lane=demo-lane"]);
  await run(["herdr", "pane", "run", "t9", "omo --model m 'go'"]);
  expect(w.calls[1]).toEqual(["hc", "send", "t9", "omo --model m 'go'"]);
});

test("a lane key that is not a valid hc name is kept only as a label", async () => {
  const w = world();
  await hcRunner(fakeHc(w))(["herdr", "tab", "create", "--cwd", "/repo", "--label", "v1.2-release"]);
  expect(w.calls[0]).not.toContain("--name");
  expect(w.calls[0]).toContain("dori.lane=v1.2-release");
});

test("sendVerified types once through hc send, drops the duplicate Enter, and confirms by hc's status turning working", async () => {
  const w = world("idle");
  expect(await sendVerified(hcRunner(fakeHc(w)), fakeClock(0), "t4", "[LEAD] hello there")).toBe("delivered");
  expect(w.calls.filter((c) => c[1] === "send" || c[1] === "keys")).toEqual([["hc", "send", "t4", "[LEAD] hello there"]]);
});

test("Escape from pause becomes hc's esc key; other keys pass through", async () => {
  const w = world();
  const run = hcRunner(fakeHc(w));
  await run(["herdr", "pane", "send-keys", "t4", "escape"]);
  await run(["herdr", "pane", "send-keys", "t4", "enter"]);
  expect(w.calls).toEqual([["hc", "keys", "t4", "esc"], ["hc", "keys", "t4", "enter"]]);
});

test("pane read with --lines returns only the last lines; without, the visible screen", async () => {
  const w = world();
  w.screen = "has stopped";
  const run = hcRunner(fakeHc(w));
  expect(await readScreen(run, "t4", 2)).toBe("line2\nhas stopped");
  expect(w.calls[0]).toEqual(["hc", "read", "t4", "--lines", "2"]);
  await readScreen(run, "t4");
  expect(w.calls[1]).toEqual(["hc", "read", "t4"]);
});

test("process-info reports the terminal pid as the shell pid; pane close kills, waits, then removes", async () => {
  const w = world();
  const run = hcRunner(fakeHc(w));
  const info = await run(["herdr", "pane", "process-info", "--pane", "t4"]);
  expect(JSON.parse(info.out)).toEqual({ result: { process_info: { shell_pid: 44 } } });
  expect((await run(["herdr", "pane", "close", "t4"])).code).toBe(0);
  expect(w.calls.slice(1).map((c) => c[1])).toEqual(["kill", "wait", "rm"]);
});

test("non-herdr commands pass through and unknown herdr commands fail loudly", async () => {
  const w = world();
  const run = hcRunner(fakeHc(w));
  await run(["git", "status"]);
  expect(w.calls[0]).toEqual(["git", "status"]);
  const r = await run(["herdr", "tab", "close", "tb1"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("no equivalent");
});
