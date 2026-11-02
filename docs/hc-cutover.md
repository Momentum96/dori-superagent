# Cutover: a Dori-mode install on herdr-core moves to this repository

This is the plan for moving a running Dori-mode lead that already runs on herdr-core (`hc`) through a local patch onto this repository: the root harness plus `skills/dori-mode`, with hc support built in. It does not run itself. A person, or the lead with the owner's approval, follows it on one machine at a time.

Paths below use `~`. "The lead terminal" is the hc terminal in `leadPane` of `~/.dori/config.json`.

## What changes and what does not

| | Before | After |
|---|---|---|
| Code | `~/.dori/src`: an older Dori-mode clone with an uncommitted hc patch (`hc-runner.ts`) | `~/.dori/superagent`: a clone of this repository. `~/.dori/src` is left untouched for rollback |
| `dori` on PATH | Dori mode's CLI, linked from `~/.dori/src/skills/dori-mode/scripts` | the harness CLI (`src/cli.ts`). It runs Dori mode's commands itself, so `dori watch`, `dori dead-panes`, `dori guard`, `dori freshness`, `dori can-launch`, `dori launch`, `dori sync`, `dori claim-done`, `dori object-done`, `dori close` and `dori send <slack|telegram|discord>` keep working. Dori mode's CLI is also linked as `dori-mode` |
| Multiplexer | `"mux": "hc"` read by the patched CLI | the same key, read by both CLIs (`DORI_MUX` overrides it) |
| Lane registry | `~/.dori/state/lanes` (Dori mode, `stateDir`) | unchanged, and still the only registry for lanes opened from the messenger |
| Harness state | none | `~/.dori/harness/{lanes,inbox,briefs,receipts,roles.json}`, created on first use. It never touches `~/.dori/state` |
| Owner channel | the messenger, through the Dori-mode lead | unchanged: the same lead, the same messenger, the same bot |
| hc server, Herdr app, launchd jobs | | untouched. Nothing here restarts the hc server, so computer use keeps working as long as the server keeps running where it was started (inside the Herdr app, or Ghostty on a machine without it) |

## Decisions

### One lead, one owner channel

The messenger-driven Dori-mode lead stays the only lead and the only session that talks to the owner. The harness's own lead/duty pair (`dori up`, `dori duty`, `prompts/lead.md`, `prompts/duty.md`) is not started:

- Lanes are still opened with `dori launch` and closed through the done protocol (`claim-done`, `watch`, `close`). A second lane system started with `dori start` would put lanes in a second registry that the monitors, the messenger threads and `dori sync` do not see.
- The duty loop's jobs are already done by the persistent monitors: `dori freshness` nudges silent lanes, `dori dead-panes` reports dead ones, `dori watch` re-checks done claims. Running `dori duty` as well would nudge the same lanes twice.
- What the lead gains from the harness is the merge gate: for a lane whose Done line is a merged PR, `dori review <owner/repo#N>` writes a receipt pinned to the head SHA and `dori merge <owner/repo#N>` merges only with a CLEAR receipt and green checks. That is optional and uses `~/.dori/harness/receipts`.
- `dori send <lead|lane|pane>` from the harness is not used either: lanes report to the lead with `hc send <lead terminal> "[REPORT] ..."` as their brief footer says.

### Two state directories, never mixed

Dori mode keeps `stateDir` (`~/.dori/state`). The harness defaults to `~/.dori/harness` (or `DORI_HOME`). Before this change the harness wrote `~/.dori/lanes`, `~/.dori/inbox`, `~/.dori/briefs` and `~/.dori/receipts` right next to Dori mode's files, with a different lane schema; now they cannot meet. Nothing has to move: there is no harness state on an install that never ran the harness.

## Before you start

1. The PR is merged and its tests passed on the merged commit.
2. The lead is idle and no `dori launch` is in progress.
3. Run the steps from a terminal other than the lead terminal.
4. Pause the lead watchdog so it does not relaunch anything mid-change: `touch ~/.dori/state/omo-restart/ensure-lead.disabled`.

## Steps (one machine)

1. **Back up.** In a dated folder under `~/.dori/backups/`:
   - copy `~/.dori/config.json`, `~/.dori/monitors.json`, `~/.dori/LEAD.md` and `~/.dori/state/monitors-armed.json`;
   - save `git -C ~/.dori/src diff` and copy the untracked `hc-runner.ts` and `hc-runner.test.ts`;
   - save `readlink ~/.bun/bin/dori`.
2. **Install side by side.**
   ```sh
   git clone https://github.com/Momentum96/dori-superagent ~/.dori/superagent
   cd ~/.dori/superagent && bun install && bun test ./test/ && bunx tsc --noEmit
   cd skills/dori-mode/scripts && bun install && bun test && bunx tsc --noEmit
   ```
3. **Switch the CLI.** The order matters: the skill package keeps its package name, so linking it first moves the old `dori` link onto the new skill CLI for a moment, and linking the root second makes `dori` the harness.
   ```sh
   cd ~/.dori/superagent/skills/dori-mode/scripts && bun link   # dori-mode
   cd ~/.dori/superagent && bun link                            # dori
   readlink ~/.bun/bin/dori        # must end in dori-superagent/src/cli.ts
   dori can-launch && dori sync    # CAN_LAUNCH; the live lanes, DRIFT none, READ_ONLY
   ```
4. **Config.** No change is required: `mux`, `leadPane`, `ignorePanes`, `laneWorkspace`, `workspaces` and the hooks mean what they meant. Do not set `DORI_HOME` to `~/.dori`.
5. **Restart scripts** (`~/.dori/integration/ensure-lead.sh`, `restart-on-omo-update.sh`). No change: they drive `hc` and `omo` directly and read `leadPane` and `defaultModel` from the config. Check with `grep -n 'dori ' ~/.dori/integration/*.sh` that neither calls the `dori` CLI.
6. **monitors.json.** The four `dori` monitors keep their commands (`~/.bun/bin/dori watch`, `dead-panes --loop 3`, `guard --loop 1`, `freshness --loop 5`). Widen two filters to what the new code prints, as in `skills/dori-mode/references/setup.md`:
   - dead panes: `^(DEAD_PANE|UNRECOGNISED_PANE)`;
   - freshness: `^(NUDGED|POSTED|NO-REPORT|PENDING-REPORT|STALE-REPORT)`.
   The messenger watcher, the re-arm reminder and other non-dori monitors do not change.
7. **LEAD.md.**
   - Point the skill at the new copy: read `~/.dori/superagent/skills/dori-mode/SKILL.md` and its references (see step 11 for the shared skill copy).
   - Replace the CLI line: `dori` is now the dori-superagent CLI and runs every Dori-mode command; `dori-mode` is the skill CLI alone.
   - The herdr-to-hc table now lives in `references/sessions.md` itself.
   - Add the rules from "One lead, one owner channel" above: no `dori up`, `dori duty` or `dori start`; `dori review` / `dori merge` may gate PR lanes; lanes still report with `hc send`.
8. **Re-register the dori monitors.** The running monitor processes still run the old code. Following the re-arm rule already in LEAD.md, stop each of the four by its recorded id, arm it again with the definition from the updated `monitors.json` (`persistent: true`), and update `~/.dori/state/monitors-armed.json`. Confirm 7 monitors are live, with no duplicates.
9. **Let the lead reload.** Send the lead one instruction (with `hc send <lead terminal> "..."` from your terminal) to re-read LEAD.md and the new SKILL.md. The skill changed since the old copy: `pause`/`resume`, more Done signal kinds (`command`, `file`, `url`), and pane state decided only from the agent status hc reports.
10. **Verify, then resume the watchdog.**
    - `dori dead-panes` and `dori guard` (one tick each) print nothing unexpected; `dori sync` shows DRIFT none.
    - Open one small QA lane with `dori launch` and a `file` or `command` Done line, see its `[REPORT]` reach the lead terminal, claim done from the lane, and see the watcher close it (its terminal is gone from `hc ls`).
    - Computer use still works in the lead (the hc server was never restarted).
    - `rm ~/.dori/state/omo-restart/ensure-lead.disabled`.
11. **Shared skill copy.** `~/.agents/skills/dori-mode` is tracked in the shared skills repository and synced to every machine, so it is updated once, after every machine has switched its CLI (step 3 on each). Until then each lead reads the skill from `~/.dori/superagent` (step 7). To update: copy `skills/dori-mode` from this repository into the skills repository, commit and push, then pull on each machine as that repository's own sync procedure says. Do not replace the folder with a symlink; it would break the shared copy on the other machines.

## Rollback

On the machine being switched, any time before or after step 11:

1. `cd ~/.dori/src/skills/dori-mode/scripts && bun link`. This relinks the old package, so `~/.bun/bin/dori` points to the old CLI with its hc patch again. Check with `readlink ~/.bun/bin/dori`. Remove the extra `~/.bun/bin/dori-mode` link.
2. Restore `monitors.json` and `LEAD.md` from the backup, and re-register the four dori monitors as in step 8.
3. Tell the lead to re-read LEAD.md.
4. `~/.dori/state` was never written by the new code in a way the old code cannot read: the lane files keep the same schema. `~/.dori/harness` can be deleted.
5. If step 11 already ran, revert that commit in the skills repository and sync again.

## The other machines

A second Mac and a Linux VPS each run their own Dori-mode lead on hc, with the same local hc patch (the VPS copy carries an extra Linux-specific change). Move them one at a time, after the first machine has run a day without trouble:

- Use the same steps, run on that machine (`hc exec --on <machine> ...` or ssh), with that machine's own config, LEAD.md and monitors file.
- On the VPS, diff its local patch against this repository before step 3, and keep whatever the new code does not already cover. The host guard already reads `/proc/loadavg` on Linux.
- Do not restart the hc server on either machine. On the second Mac the server runs inside a terminal app that holds the screen-recording and accessibility permissions; computer use depends on that.
- Run step 11 only after the last machine has switched.
