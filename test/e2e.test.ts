import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { shq, spawnExec } from "../src/herdr.ts";

// Real herdr, isolated named session, fake agent instead of a model: proves the pane plumbing end to end.
const herdrBin = Bun.which("herdr");
const session = `dori-e2e-${process.pid}`;
const home = mkdtempSync(join(tmpdir(), "dori-e2e-"));
const cli = resolve(import.meta.dir, "../src/cli.ts");
const env = { ...process.env, DORI_HOME: home, DORI_HERDR_SESSION: session, DORI_MUX: "herdr" };
let server: ReturnType<typeof Bun.spawn> | undefined;

const herdr = async (...argv: string[]) => {
  const r = await spawnExec("herdr", ["--session", session, ...argv]);
  if (r.code !== 0) throw new Error(r.stderr || r.stdout);
  return JSON.parse(r.stdout || "{}").result;
};
const dori = async (...argv: string[]) => {
  const p = Bun.spawn(["bun", cli, ...argv], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`dori ${argv.join(" ")} -> ${code}: ${err}`);
  return out;
};
const until = async <T>(what: string, probe: () => Promise<T | undefined>, ms = 20_000): Promise<T> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await probe().catch(() => undefined);
    if (v !== undefined) return v;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
};

beforeAll(async () => {
  if (!herdrBin) return;
  server = Bun.spawn([herdrBin, "--session", session, "server"], { stdout: "ignore", stderr: "ignore" });
  await until("herdr server", () => herdr("workspace", "list"));
});

afterAll(async () => {
  if (!herdrBin) return;
  await spawnExec("herdr", ["--session", session, "server", "stop"]);
  await server?.exited;
  await spawnExec("herdr", ["session", "delete", session]);
});

test.skipIf(!herdrBin)("a lane started in real herdr reports and finishes, and the lead pane receives both", async () => {
  const ws = await herdr("workspace", "create", "--label", "e2e", "--cwd", home, "--no-focus");
  const lead = ws.root_pane.pane_id as string;
  await herdr("pane", "run", lead, "cat");
  await dori("role", "lead", lead);
  const brief = join(home, "brief.md");
  writeFileSync(brief, "E2E-BRIEF say hello\n");

  const fake = resolve(import.meta.dir, "fixtures/fake-agent.sh");
  const doriCmd = `DORI_HOME=${shq(home)} DORI_HERDR_SESSION=${session} bun ${shq(cli)}`;
  const started = Bun.spawn(["bun", cli, "start", "e2e-lane", "--brief", brief, "--workspace", ws.workspace.workspace_id], {
    env: { ...env, DORI_AGENT_CMD: `DORI_E2E_CMD=${shq(doriCmd)} ${shq(fake)}`, DORI_CMD: doriCmd },
    stdout: "pipe", stderr: "pipe",
  });
  expect(await started.exited).toBe(0);

  const leadText = await until("READY in the lead pane", async () => {
    const r = await spawnExec("herdr", ["--session", session, "pane", "read", lead, "--lines", "60", "--source", "recent"]);
    return r.stdout.includes("[READY e2e-lane]") ? r.stdout : undefined;
  });
  expect(leadText).toContain("[START e2e-lane]");
  expect(leadText).toContain("[REPORT e2e-lane] read brief: E2E-BRIEF say hello");
  expect(leadText).toContain("[READY e2e-lane] e2e lane finished");
  expect(await dori("status")).toMatch(/e2e-lane\s+ready/);
  expect(await dori("done", "e2e-lane")).toContain("DONE e2e-lane");
}, 60_000);
