import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { World } from "./fake.ts";

// CLI scenarios use only the injectable fake transport: no installed mux or production configuration.
function setup() {
  const w = new World();
  const d = w.deps();
  const lead = w.addPane("w1:p1", "shell");
  d.store.setRole("lead", "w1:p1");
  const brief = join(d.store.root, "brief.md");
  writeFileSync(brief, "E2E-BRIEF say hello\n");
  const cli = async (...argv: string[]) => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
    try { expect(await main(argv, d)).toBe(0); } finally { console.log = original; }
    return lines.join("\n");
  };
  return { w, d, lead, brief, cli };
}

test("a CLI lane reports and claims done; a lead with no agent retains both until it returns", async () => {
  const { d, lead, brief, cli } = setup();
  expect(await cli("start", "e2e-lane", "--brief", brief, "--done", `file ${brief}`)).toContain("STARTED e2e-lane");
  await cli("report", "e2e-lane", "--text", "read brief: E2E-BRIEF say hello");
  await cli("ready", "e2e-lane", "--text", "e2e lane finished", "--evidence", brief);
  expect(lead.received).toEqual([]);
  const mail = d.store.queued("w1:p1").map((m) => m.text).join("\n");
  expect(mail).toContain("[START e2e-lane]");
  expect(mail).toContain("[REPORT] e2e-lane | milestone | read brief: E2E-BRIEF say hello");
  expect(mail).toContain("[READY e2e-lane] e2e lane finished");
  expect(await cli("status")).toMatch(/e2e-lane\s+done-claimed/);
  lead.status = "idle";
  await cli("duty", "--once");
  expect(lead.received).toHaveLength(1);
  expect(lead.received[0]).toContain("[READY e2e-lane]");
  expect(d.store.queued("w1:p1")).toEqual([]);
  expect(await cli("done", "e2e-lane")).toContain("CLOSED e2e-lane");
});

test("the CLI hourly loop starts a backlog lane, reports the run and honors its stop switch", async () => {
  const { d, lead, brief, cli } = setup();
  expect(await cli("backlog", "add", "loop-item", "--brief", brief, "--done", `file ${brief}`, "--priority", "2")).toContain("ADDED loop-item p2");
  expect(await cli("loop", "--once", "--max-lanes", "5")).toContain("LOOP started=1");
  await cli("report", "loop-item", "--text", "read brief");
  await cli("ready", "loop-item", "--text", "finished", "--evidence", brief);
  const mail = d.store.queued("w1:p1").map((m) => m.text).join("\n");
  expect(lead.received).toEqual([]);
  expect(mail).toContain("[START loop-item]");
  expect(mail).toContain("[READY loop-item]");
  expect(mail).toContain("[LOOP ");
  expect(mail).toContain("started: loop-item (p2)");
  expect(await cli("backlog", "list")).toMatch(/loop-item\s+running/);
  expect(await cli("loop", "status")).toContain("started: loop-item (p2)");
  expect(await cli("loop", "stop", "--text", "e2e pause")).toContain("LOOP STOPPED");
  expect(await cli("loop", "--once")).toContain("LOOP skipped: stopped: e2e pause");
  expect(await cli("done", "loop-item")).toContain("CLOSED loop-item");
});
