import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DoriConfig } from "../src/config.ts";
import { prepareLaunch } from "../src/launch.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const T0 = Date.parse("2026-11-21T02:00:00.000Z");
const LEAD_SESSION = "019a7c1e-lead-session";
let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

const brief = async (patch: Partial<DoriConfig>): Promise<string> => {
  const file = join(state.dir, "brief.md");
  writeFileSync(file, "# brief\n");
  const deps = depsFor(newWorld(), fakeClock(T0), state.dir, { leadPane: LEAD_SESSION, ...patch });
  return (await prepareLaunch(deps, { key: "fix-x", title: "t", brief: file, done: "closed acme/app#3" })).preamble;
};

test("T2.7 a lane launched under an omo-host lead names no lead session and no hc send, and says not to send the line", async () => {
  // Given an omo-host lead whose session id is the configured lead pane
  const text = await brief({ runtime: "hc", leadRuntime: "omo-host" });
  // Then the brief never names that session or a send command, and tells the lane `dori report` is the whole delivery
  expect(text).not.toContain(LEAD_SESSION);
  expect(text).not.toContain("hc send");
  expect(text).not.toContain("herdr pane run");
  expect(text).toContain("출력된 줄을 어디에도 보내지 말 것");
  expect(text).toContain("질문 도구(question tool)는 쓰지 말 것");
  expect(text).toMatch(/report fix-x --kind question\|blocker/);
});

test("leadInbox true puts an hc lead's lanes on the inbox path too", async () => {
  const text = await brief({ runtime: "hc", leadRuntime: "hc", leadInbox: true });
  expect(text).not.toContain(LEAD_SESSION);
  expect(text).not.toContain("hc send");
  expect(text).toContain("보내지 말 것");
});

test("an hc lead without leadInbox keeps its send argv and no question-tool line", async () => {
  const text = await brief({ runtime: "hc", leadRuntime: "hc" });
  expect(text).toContain(JSON.stringify(["hc", "send", LEAD_SESSION, "--", "[REPORT] ..."]));
  expect(text).not.toContain("보내지 말 것");
  expect(text).not.toContain("question tool");
});
