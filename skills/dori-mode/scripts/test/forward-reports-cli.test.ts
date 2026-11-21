import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Registry } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import { withState } from "./fakes.ts";

const T0 = Date.parse("2026-11-21T02:00:00.000Z");
let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

const lane = (key: string) => ({
  key,
  title: key,
  thread: `thread-${key}`,
  brief: "/tmp/brief.md",
  done: "closed acme/app#3",
  openedAt: new Date(T0).toISOString(),
  reportProtocol: "jsonl-v1" as const,
});

test("--state-dir reads another home's journals and --bot fills that bot's local inbox under the config's state", async () => {
  // Given a config whose own state holds the lead inbox, and an omp node home elsewhere with one done report
  const lead = join(state.dir, "lead-state");
  const node = join(state.dir, "omp-node", "state");
  mkdirSync(lead, { recursive: true });
  await new Registry(node).write(lane("omp-check"));
  new Reports(node).report("omp-check", "done", "finished", T0);
  const config = join(state.dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: lead, machine: "hosthatch" }));
  /** One CLI run, settled: both pipes drained and the exit awaited, so no child outlives its step. */
  const cli = async (...args: string[]) => {
    const env: Record<string, string | undefined> = { ...process.env, DORI_CONFIG: config };
    delete env["DORI_STATE_DIR"];
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, out };
  };
  // When forward-reports runs once with both options
  const fwd = await cli("forward-reports", "--once", "--state-dir", node, "--bot", "omp");
  expect(fwd.out).toContain("FORWARDED omp-check r:hosthatch:omp-check:0 done");
  expect(fwd.code).toBe(0);
  // Then the omp inbox in the config's state holds the item, and the cursor lives in the node home
  const list = await cli("lead-inbox", "list", "--bot", "omp", "--json");
  const rows = JSON.parse(list.out) as { id: string }[];
  expect(rows.map((r) => r.id)).toEqual(["r:hosthatch:omp-check:0"]);
  expect(existsSync(join(node, "forwarder", "cursors.json"))).toBe(true);
  expect(existsSync(join(lead, "forwarder"))).toBe(false);
  // And a bad bot name is refused before anything is sent
  expect((await cli("forward-reports", "--once", "--state-dir", node, "--bot", "Bad Bot")).code).toBe(2);
});
