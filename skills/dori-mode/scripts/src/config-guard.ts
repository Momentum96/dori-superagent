import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The shared agent configuration every session on the machine reads. A lane that edits one of these files (or lets a
// test gateway wire itself into them) changes the lead's own model route (2026-11-25: models.json pointed at a test
// gateway that was then shut down, and every lead call failed until the owner asked whether it was alive).
const GUARDED = [".omo/agent/models.json", ".omo/omo.jsonc", ".omo/agent/settings.json"] as const;

export type ConfigSnapshot = Readonly<Record<string, string>>;

const digest = (path: string): string => {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "absent";
  }
};

const homeOf = (env: Readonly<Record<string, string | undefined>> | undefined): string =>
  env?.["HOME"] ?? process.env["HOME"] ?? homedir();

/** Each guarded file's content digest ("absent" when it is not there), keyed by absolute path. */
export const snapshotConfig = (env?: Readonly<Record<string, string | undefined>>): ConfigSnapshot =>
  Object.fromEntries(GUARDED.map((rel) => join(homeOf(env), rel)).map((path) => [path, digest(path)]));

/** The files whose content differs from the launch snapshot; none for a lane launched before snapshots existed. */
export const changedConfig = (before: ConfigSnapshot | undefined): string[] =>
  Object.entries(before ?? {})
    .filter(([path, was]) => digest(path) !== was)
    .map(([path]) => path);

export const configWarning = (changed: readonly string[]): string =>
  `CONFIG_CHANGED ${changed.join(", ")} differs from launch; if the lane did not mean to change the shared agent configuration, restore it (a test gateway or provider edit here breaks the lead's model route)`;
