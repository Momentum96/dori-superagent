import { expect, test } from "bun:test";
import { main } from "../src/cli.ts";
import { Registry } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import { withState } from "./fakes.ts";

test("the imported CLI returns codes and reloads configuration on each invocation", async () => {
  const state = withState();
  const saved = { config: process.env.DORI_CONFIG, state: process.env.DORI_STATE_DIR, mux: process.env.DORI_MUX };
  try {
    process.env.DORI_CONFIG = `${state.dir}/config.json`;
    process.env.DORI_STATE_DIR = state.dir;
    process.env.DORI_MUX = "hc";
    const registry = new Registry(state.dir);
    await registry.write({ key: "legacy", title: "legacy", brief: "/brief", done: "file /done", thread: "none", openedAt: new Date(0).toISOString() });
    expect(await main(["report", "legacy", "--kind", "milestone", "--text", "journal only"])).toBe(0);
    expect(new Reports(state.dir).read("legacy")?.lastReport?.text).toBe("journal only");
    expect((await registry.read("legacy"))?.lastReport).toBeUndefined();
    expect(await main(["report", "legacy", "--kind", "invalid", "--text", "bad"])).toBe(1);
    process.env.DORI_MUX = "invalid";
    expect(await main(["boot"])).toBe(1);
  } finally {
    for (const [key, value] of Object.entries({ DORI_CONFIG: saved.config, DORI_STATE_DIR: saved.state, DORI_MUX: saved.mux })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    state.done();
  }
});
