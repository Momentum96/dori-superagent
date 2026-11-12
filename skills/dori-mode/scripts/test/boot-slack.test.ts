import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { bootCheck, slackAuthCheck } from "../src/boot.ts";
import { Slack } from "../src/messenger/slack.ts";
import { Reports } from "../src/reports.ts";
import { Worklog } from "../src/worklog.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");

let state: ReturnType<typeof withState>;

beforeEach(() => {
  state = withState();
});

afterEach(() => state.done());

const bootDeps = (world: World, slack: () => Promise<{ userId: string; teamId: string } | null> = async () => null) => {
  const sessionsDir = join(state.dir, "sessions");
  const deps = depsFor(world, fakeClock(T0), state.dir, { sessionsDir, leadPane: "w2:p1" });
  return { ...deps, reports: new Reports(state.dir), worklog: new Worklog(state.dir), slack, sessionsDir };
};

test("Slack is optional, and a failed check never prints the provider error", async () => {
  // Given no token, then a token whose auth.test fails with a secret-looking message.
  const world = newWorld();
  const skipped = await bootCheck(bootDeps(world));
  const failed = await bootCheck(
    bootDeps(world, async () => {
      throw new Error("FIXTURE_TOKEN");
    }),
  );
  // Then a missing token is a skip, and a failure is incomplete without the error text.
  expect(skipped.lines).toContain("SLACK skipped (DORI_SLACK_TOKEN not set)");
  expect(skipped.exitCode).toBe(0);
  expect(failed.lines).toContain("SLACK auth failed");
  expect(failed.exitCode).toBe(1);
  expect(failed.lines.join("\n")).not.toContain("FIXTURE_TOKEN");
});

test("the Slack step reads auth.test through the client and fails when it returns no user or team id", async () => {
  // Given a Slack client whose auth.test succeeds with both ids, then with the team id missing.
  const slackWith = (body: Record<string, unknown>) => {
    const calls: string[] = [];
    const http = async (req: { url: string }) => {
      calls.push(req.url);
      return { status: 200, headers: {}, body: JSON.stringify(body) };
    };
    return { slack: new Slack(http, fakeClock(T0), { token: "xoxp-FIXTURE" }, "https://slack.test/api"), calls };
  };
  const ok = slackWith({ ok: true, user_id: "U_FIXTURE", team_id: "T_FIXTURE" });
  const partial = slackWith({ ok: true, user_id: "U_FIXTURE" });
  // When boot runs with each; then the full one authenticates through auth.test and the partial one fails.
  const world = newWorld();
  const good = await bootCheck({ ...bootDeps(world), slack: slackAuthCheck(ok.slack) });
  const bad = await bootCheck({ ...bootDeps(world), slack: slackAuthCheck(partial.slack) });
  expect(ok.calls).toEqual(["https://slack.test/api/auth.test"]);
  expect(good.lines).toContain(
    "SLACK authenticated user=U_FIXTURE team=T_FIXTURE (auth.test only; inbox delivery unverified)",
  );
  expect(bad.lines).toContain("SLACK auth failed");
  expect(bad.exitCode).toBe(1);
  expect(await slackAuthCheck(null)()).toBeNull();
});

test("Slack runs after the local checks and a stalled auth.test ends at the deadline", async () => {
  // Given a Slack step that records how many local calls ran before it, then never answers.
  const world = newWorld();
  let localCallsFirst = -1;
  const stalled = async () => {
    localCallsFirst = world.calls.length;
    return await new Promise<never>(() => {});
  };
  // When boot runs with a short deadline.
  const result = await bootCheck({ ...bootDeps(world, stalled), slackDeadlineMs: 20 });
  // Then the pane list ran first, the stall is reported as a timeout, and the run is incomplete.
  expect(localCallsFirst).toBe(1);
  expect(result.lines).toContain("SLACK auth.test timed out after 20 ms");
  expect(result.lines.at(-1)).toBe("BOOT incomplete read-only; nothing restarted, written or stopped");
  expect(result.exitCode).toBe(1);
});
