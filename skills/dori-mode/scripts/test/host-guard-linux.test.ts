import { expect, test } from "bun:test";
import { sampleHost } from "../src/host-guard.ts";
import type { Runner } from "../src/run.ts";

test("linux host reads load, memory and swap from /proc when macOS tools are missing", async () => {
  const out: Record<string, string> = {
    "cat /proc/loadavg": "3.50 2.00 1.00 1/500 123\n",
    "cat /proc/meminfo": "MemTotal:       32000000 kB\nMemFree:         1000000 kB\nMemAvailable:    8000000 kB\nSwapTotal:       2097152 kB\nSwapFree:        1048576 kB\n",
    "df -k /": "Filesystem 1K-blocks Used Available Use% Mounted\n/dev/vda1 117000000 3000000 104857600 3% /",
    "herdr pane list": JSON.stringify({ result: { panes: [1, 2] } }),
  };
  const run: Runner = async (argv) => {
    const k = argv.join(" ");
    return k in out ? { code: 0, out: out[k]!, err: "" } : { code: 127, out: "", err: "not found" };
  };
  const s = await sampleHost(run);
  expect(s.load1).toBe(3.5);
  expect(s.memFreePct).toBe(25);
  expect(s.swapFreeGb).toBe(1);
  expect(Math.round(s.diskFreeGb)).toBe(100);
  expect(s.panes).toBe(2);
});
