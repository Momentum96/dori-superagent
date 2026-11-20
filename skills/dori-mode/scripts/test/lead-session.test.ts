import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { FakeOmoHost } from "../../../../test/fake-omo-host.ts";
import type { Exec } from "../../../../src/runtime/exec.ts";
import { LeadSessionError, leadStatus, openLead, replaceLead } from "../src/lead-session.ts";
import { type LeadState, LeadStateError, parseLeadState, readLeadState, writeLeadState } from "../src/lead-state.ts";
import { fakeClock, withState } from "./fakes.ts";

const T0 = Date.parse("2026-11-21T02:00:00.000Z");
const MODEL = "anthropic/claude-opus-5-5";
let state: ReturnType<typeof withState>;
let host: FakeOmoHost;
let alerts: string[];
let before: (argv: readonly string[]) => Promise<void>;
let cwd: string;
let rules: string;

beforeEach(() => {
  state = withState();
  host = new FakeOmoHost();
  alerts = [];
  before = async () => {};
  cwd = join(state.dir, "lead-home");
  mkdirSync(cwd);
  rules = join(state.dir, "LEAD.md");
  writeFileSync(rules, "# rules\n");
});
afterEach(() => state.done());

const exec: Exec = async (cmd, argv) => {
  await before(argv);
  return host.exec(cmd, argv);
};
const deps = () => ({
  stateDir: state.dir,
  exec,
  clock: fakeClock(T0),
  alert: async (text: string) => void alerts.push(text),
});
const open = () => openLead(deps(), { bot: "omo", cwd, runtime: "omo-host", model: MODEL, rulesFile: rules });
const naming = (id: string): string[][] => host.calls.filter((c) => c.includes(id));

test("open starts the host session with the rules as its first prompt and writes generation 1", async () => {
  const lead = await open();
  expect(host.calls).toEqual([
    ["open", "--cwd", cwd, "--model", MODEL, "--name", "dori-lead-omo", "--prompt", `@${rules}`],
  ]);
  expect(await readLeadState(state.dir, "omo")).toEqual(lead);
  expect(lead).toMatchObject({ state: "active", generation: 1, rules: "first-prompt", rulesFile: rules, retired: [] });
  expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
});

test("a second open while a lead is recorded is refused and calls nothing", async () => {
  await open();
  const calls = host.calls.length;
  await expect(open()).rejects.toMatchObject({ code: 3 });
  expect(host.calls.length).toBe(calls);
});

test("replace retires the old id, raises the generation, and never names the old id again (T2.6)", async () => {
  const first = await open();
  const r = await replaceLead(deps(), { bot: "omo", rulesFile: rules });
  expect(r.lead).toMatchObject({ state: "active", generation: 2, retired: [first.sessionId] });
  expect(r.lead.sessionId).not.toBe(first.sessionId);
  expect(naming(first.sessionId).map((c) => c[0])).toEqual(["state", "close"]);
  await replaceLead(deps(), { bot: "omo", rulesFile: rules });
  expect(naming(first.sessionId).map((c) => c[0])).toEqual(["state", "close"]);
  expect((await leadStatus(state.dir, "omo")).generation).toBe(3);
});

test("status reads switching while the replace is between close and open", async () => {
  await open();
  const seen: string[] = [];
  before = async (argv) => {
    if (argv[2] === "close" || argv[2] === "open") seen.push((await leadStatus(state.dir, "omo")).state);
  };
  await replaceLead(deps(), { bot: "omo", rulesFile: rules });
  expect(seen).toEqual(["switching", "switching"]);
  expect((await leadStatus(state.dir, "omo")).state).toBe("active");
});

test("a close answered closed:false is recorded and alerted once, and the replace completes", async () => {
  const first = await open();
  host.refusesClose.add(first.sessionId);
  const r = await replaceLead(deps(), { bot: "omo", rulesFile: rules });
  expect(r.closeFailure).toMatchObject({ id: first.sessionId, at: "2026-11-21T02:00:00.000Z" });
  expect(JSON.parse(r.closeFailure?.answer ?? "{}")).toMatchObject({ closed: false });
  expect(alerts).toHaveLength(1);
  expect(r.lead.closeFailures).toEqual([r.closeFailure ?? expect.anything()]);
  await replaceLead(deps(), { bot: "omo", rulesFile: rules });
  expect(naming(first.sessionId).map((c) => c[0])).toEqual(["state", "close"]);
  expect((await leadStatus(state.dir, "omo")).closeFailures).toHaveLength(1);
});

test("a replace cut off after its close is finished by a second run without closing or asking the old id", async () => {
  const first = await open();
  host.refuseNext.set("open", "host_unavailable");
  await expect(replaceLead(deps(), { bot: "omo", rulesFile: rules })).rejects.toThrow(/host_unavailable/);
  expect(await leadStatus(state.dir, "omo")).toMatchObject({ state: "switching", retired: [first.sessionId] });
  await expect(replaceLead(deps(), { bot: "omo", rulesFile: rules })).rejects.toMatchObject({ code: 2 });
  const r = await replaceLead(deps(), { bot: "omo", rulesFile: rules, model: MODEL });
  expect(r.lead).toMatchObject({ state: "active", generation: 2, retired: [first.sessionId] });
  expect(naming(first.sessionId).map((c) => c[0])).toEqual(["state", "close"]);
});

test("a run cut off after its open lists that orphan session on the next run", async () => {
  await open();
  const opened: string[] = [];
  before = async (argv) => {
    if (argv[2] === "open" && opened.length === 0) {
      opened.push("x");
      await host.exec("omo", argv);
      throw new Error("killed after open");
    }
  };
  await expect(replaceLead(deps(), { bot: "omo", rulesFile: rules })).rejects.toThrow(/killed after open/);
  const r = await replaceLead(deps(), { bot: "omo", rulesFile: rules, model: MODEL });
  expect(r.orphans).toHaveLength(1);
  expect(r.orphans).not.toContain(r.lead.sessionId);
});

test("an hc lead records the pane and opens nothing; replace refuses it", async () => {
  const lead = await openLead(deps(), { bot: "omo", cwd, runtime: "hc", pane: "t3" });
  expect(lead).toMatchObject({ runtime: "hc", sessionId: "t3", generation: 1 });
  expect(host.calls).toEqual([]);
  await expect(replaceLead(deps(), { bot: "omo", rulesFile: rules })).rejects.toBeInstanceOf(LeadSessionError);
});

test("a corrupt or empty lead.json stops open and replace before any host call", async () => {
  for (const body of ["{not json", "{}"]) {
    mkdirSync(join(state.dir, "lead"), { recursive: true });
    writeFileSync(join(state.dir, "lead", "omo.json"), body);
    await expect(open()).rejects.toBeInstanceOf(LeadStateError);
    await expect(replaceLead(deps(), { bot: "omo", rulesFile: rules })).rejects.toBeInstanceOf(LeadStateError);
  }
  expect(host.calls).toEqual([]);
});

test("lead state keeps rules, rulesFile and closeFailures through a round trip; a bad closeFailures is refused", async () => {
  const lead: LeadState = {
    bot: "omo",
    runtime: "omo-host",
    generation: 2,
    sessionId: "new",
    state: "active",
    retired: ["old"],
    cwd,
    rules: "first-prompt",
    rulesFile: rules,
    closeFailures: [{ id: "old", at: "2026-11-21T02:00:00.000Z", answer: '{"closed":false}' }],
  };
  writeLeadState(state.dir, lead);
  const back = await readLeadState(state.dir, "omo");
  expect(back).toEqual(lead);
  if (back) writeLeadState(state.dir, back);
  expect(JSON.parse(readFileSync(join(state.dir, "lead", "omo.json"), "utf8"))).toEqual(lead);
  for (const closeFailures of [{}, [{ id: "old" }], [{ id: "", at: "t", answer: "a" }], ["old"]])
    expect(() => parseLeadState({ ...lead, closeFailures })).toThrow(LeadStateError);
});
