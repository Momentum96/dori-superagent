# Cutover: a Dori-mode install on herdr-core moves to this repository

This is the plan for moving a running Dori-mode lead that already runs on herdr-core (`hc`) through a local patch onto this repository: the root harness plus `skills/dori-mode`, with hc support built in, and the harness's duty session and duty loop added next to the existing lead. It does not run itself. A person, or the lead with the owner's approval, follows it on one machine at a time.

Paths below use `~`. "The lead terminal" is the hc terminal in `leadPane` of `~/.dori/config.json`.

## The structure after the cutover

| Part | What it is | Where it runs | Who restarts it |
|---|---|---|---|
| Lead | the existing messenger-driven Dori-mode session; also the harness's lead (`leadPane`). The only session that talks to the owner, on the one messenger channel | the lead terminal | `ensure-lead.sh` (launchd, every minute), as today |
| Duty session | an omo session with `prompts/duty.md`: handles dead panes and blockers the loop hands it, escalates to the lead, never talks to the owner | hc terminal `duty`, in the lane space (`laneWorkspace`) | `dori up` |
| Duty loop | `dori duty --interval 60`: inbox delivery, `[LOST]`, the freshness sweep (nudge + thread post), the dead-pane sweep, `[ESCALATE]`, a heartbeat | hc terminal `duty-loop`, same space | `dori up` (replaces it when the heartbeat is older than three intervals) |
| Lanes | one registry, `~/.dori/state/lanes`, whether opened with `dori launch` or `dori start` | their own hc terminals in the lane space | the lead |

`dori up` is idempotent and never starts a second lead: when the configured lead is gone it says so and leaves it to `ensure-lead.sh`. It starts the duty session when its terminal is gone, restarts the agent when only a shell is left, replaces an idle duty session that runs an older agent than `omo --version` reports now (a busy one waits until it is idle), and replaces the loop when it stopped beating. So it is safe to run every minute.

### Who notices when the duty loop dies

Two independent paths, so lane monitoring cannot stop silently the way the lead's monitors once disappeared for 13 days:

1. `ensure-lead.sh` runs `dori up` on every launchd tick, after its lead check. That brings the duty session and loop back even when the lead itself is down.
2. The lead keeps a persistent monitor `dori duty-watch --loop 1` (filter `^DUTY_`). When the heartbeat in `~/.dori/harness/duty-heartbeat.json` is older than 3 minutes it prints one `DUTY_STALE ...; run: dori up`, and `DUTY_OK` when it is back. If launchd has stopped working, this wakes the lead.

### Lanes, reports and done

- `dori start <key> --brief F --done "<signals>" [--thread <ref>]` is `dori launch` plus a `[START]` to the lead. Both write the same registry, so `dori sync`, freshness, dead-panes, the thread hooks and the claim-done/watch flow see every lane.
- The lane footer now tells lanes to report with `dori report <key> --kind <milestone|blocker|question|done> --text "..."`. That records the line on the lane (`lastReport`), resets its quiet clock, and delivers it to the lead, queued while the lead is busy. Freshness posts the recorded line to the lane's thread, so a quiet lane's last report reaches the thread on hc too, where the line never shows on the lane's own screen. Lanes opened before the cutover keep reporting with `hc send`; for them freshness still falls back to the screen.
- `dori ready <key> --text ... --evidence ...` is a done claim carrying the final answer. The watcher closes the lane once its Done signals read back live; `dori done <key>` closes it at once under the same check.
- On hc nothing is pasted into a terminal that runs no agent: the harness keeps such messages queued, and Dori mode's pane runner refuses the text, because pasted into a shell it would run as a command.

### State

Lanes stay in Dori mode's `stateDir` (`~/.dori/state`). What only the harness has (roles, pane inboxes, rendered prompts, review receipts, the duty heartbeat, the duty session's agent version) is in `~/.dori/harness` (`DORI_HOME`). The lane schema only gains optional fields (`lastReport`, `lostReportedAt`, `escalatedAt`), which the old code ignores.

## Before you start

1. The PR is merged and its tests passed on the merged commit.
2. The lead is idle and no `dori launch` is in progress.
3. Run the steps from a terminal other than the lead terminal.
4. Pause the lead watchdog so it does not relaunch anything mid-change: `touch ~/.dori/state/omo-restart/ensure-lead.disabled`.

## Steps (one machine)

1. **Back up.** In a dated folder under `~/.dori/backups/`:
   - copy `~/.dori/config.json`, `~/.dori/monitors.json`, `~/.dori/LEAD.md`, `~/.dori/state/monitors-armed.json` and `~/.dori/integration/ensure-lead.sh`;
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
4. **Config.** No change is required: `mux`, `leadPane`, `ignorePanes`, `laneWorkspace`, `workspaces`, `nudgeAfterMin`, `postAfterMin` and the hooks keep their meaning, and the harness reads `leadPane` as its lead. Do not set `DORI_HOME` to `~/.dori`.
5. **Start the duty session and loop once by hand.**
   ```sh
   DORI_AGENT_CMD="omo --offline --model <defaultModel>" dori up --cwd ~/.dori
   # UP LEAD <lead terminal> idle / UP DUTY started tN / UP LOOP started tM
   dori status                     # lead=<lead> duty=tN loop=tM beat=<seconds> ago
   dori duty-watch --loop 0        # DUTY_WATCH_READY and nothing else (exit 0)
   ```
6. **Restart scripts.**
   - `ensure-lead.sh`: after its lead check, on every run where the hc core is up, add one line. Keep the agent command in step with `defaultModel`, and notify through the messenger on failure as the script already does for the lead:
     ```sh
     DORI_AGENT_CMD="omo --offline --model $MODEL" dori up --cwd "$HOME/.dori" >>"$STATE/dori-up.log" 2>&1 || notify "dori up failed; see $STATE/dori-up.log"
     ```
     It is safe while the lead is down: `dori up` reports a gone lead and leaves its relaunch to the lines above it.
   - `restart-on-omo-update.sh`: no change needed. The duty session runs the same omo; `dori up` records the version it started the duty session with (`~/.dori/harness/duty-agent.json`) and replaces the session once it is idle and the installed omo differs, so the next `ensure-lead.sh` tick after an update moves it to the new version.
   - Check with `grep -n 'dori ' ~/.dori/integration/*.sh` that nothing else calls the `dori` CLI.
7. **monitors.json.** The duty loop now runs freshness and dead-panes, so the lead must stop running them or every quiet lane would be nudged twice:
   - remove the dead-pane monitor (`dori dead-panes --loop 3`);
   - remove the freshness monitor (`dori freshness --loop 5`);
   - add a duty-loop liveness monitor: command `~/.bun/bin/dori duty-watch --loop 1`, filter `^DUTY_`;
   - keep the done watcher (`dori watch`, `^LANE_`), the host guard (`dori guard --loop 1`, `^HOST_GUARD`), the messenger watcher, the re-arm reminder and the other non-dori monitors as they are.
8. **LEAD.md.**
   - Point the skill at the new copy: read `~/.dori/superagent/skills/dori-mode/SKILL.md` and its references (see step 12 for the shared skill copy).
   - Replace the CLI line: `dori` is now the dori-superagent CLI and runs every Dori-mode command; `dori-mode` is the skill CLI alone.
   - Add the harness lead rules from `prompts/lead.md`:
     - lanes open with `dori start ... --done ... --thread ...` or `dori launch`;
     - lane messages arrive as `[START]`, `[REPORT] key | kind | text`, `[READY]`, `[LOST]`, `[ESCALATE]` and `[PAUSED-BUT-WORKING]`;
     - on `DUTY_STALE` run `dori up`;
     - the duty session never talks to the owner, so everything still reaches the owner through the lead, on Discord.
   - In the monitor rules, replace the two removed monitors with the duty-watch monitor.
9. **Re-register the monitors.** The running monitor processes still run the old code. Following the re-arm rule already in LEAD.md:
   - stop the dead-pane and freshness monitors by their recorded ids and do not re-arm them;
   - stop and re-arm the done watcher and the host guard with their definitions from the updated `monitors.json` (`persistent: true`);
   - arm the new duty-watch monitor;
   - update `~/.dori/state/monitors-armed.json`, and confirm 6 monitors are live with no duplicates.
10. **Let the lead reload.** Send the lead one instruction, with `hc send <lead terminal> "..."` from your terminal, to re-read LEAD.md and the new SKILL.md.
11. **Verify, then resume the watchdog.**
    - Open one small QA lane with `dori start` and a `file` or `command` Done line, plus `--thread` set to a test thread.
      - `[START]` and its `dori report` line reach the lead terminal.
      - `dori status` shows its last report.
      - `dori ready` from the lane reaches the lead as `[READY]`, and the watcher closes the lane (its terminal is gone from `hc ls`).
    - Kill the duty-loop terminal (`hc kill <loop terminal>`). Within 3 minutes the lead's duty-watch monitor fires `DUTY_STALE`, and the next `dori up` (yours, or launchd's once the watchdog runs again) replaces the loop; then `DUTY_OK`.
    - Computer use still works in the lead (the hc server was never restarted).
    - `rm ~/.dori/state/omo-restart/ensure-lead.disabled`, then watch `dori-up.log` for one launchd tick reporting `LEAD ... idle`, `DUTY ... idle` and `LOOP alive`.
12. **Shared skill copy.** `~/.agents/skills/dori-mode` is tracked in the shared skills repository and synced to every machine. Update it once, after every machine has switched its CLI (step 3 on each); until then each lead reads the skill from `~/.dori/superagent` (step 8).
    - To update: copy `skills/dori-mode` from this repository into the skills repository, commit and push, then pull on each machine as that repository's own sync procedure says.
    - Do not replace the folder with a symlink; it would break the shared copy on the other machines.

## 후속 적용

Follow-ups found after the three machines switched to 8c29902 (inbox order, done-claimed escalations, legacy-lane escalations, the hc pane count, the duty session after an omo update). They need no config change. On each machine, after the PR is merged:

1. `git -C ~/.dori/superagent pull --ff-only`.
2. The running processes keep the old code until they restart. Stop the duty loop once (`hc kill <duty-loop terminal>`, from `~/.dori/harness/roles.json`); the next `dori up` replaces it once its heartbeat is stale (within 3 minutes, with one `DUTY_STALE` / `DUTY_OK` pair at the lead).
3. Re-arm the host guard monitor (`dori guard --loop 1`, filter `^HOST_GUARD`) following the re-arm rule in LEAD.md.

The first `dori up` after the pull finds no `duty-agent.json`, so it replaces the duty session once, as soon as it is idle. After that it replaces it only after an omo update.

Per machine, the one-line change to its restart scripts:

- MacBook: none. `ensure-lead.sh` already runs `dori up` every minute (launchd `ai.dori.ensure-lead`), which moves the duty session to the new omo within a minute of it going idle. `restart-on-omo-update.sh` stays as it is.
- Mac mini: none, for the same reason (its `ensure-lead.sh` runs `dori up` on the launchd tick).
- hosthatch: none. Its systemd timer (`dori-ensure-lead.timer`) runs `ensure-lead.sh`, which already runs `dori up`.
- Optional, any machine, to apply right after an update instead of on the next tick: append to `restart-on-omo-update.sh`, after the lead relaunch, `DORI_AGENT_CMD="omo --offline --model $MODEL" dori up --cwd "$HOME/.dori" >>"$STATE/dori-up.log" 2>&1`.

## Rollback

On the machine being switched, at any point:

1. Stop the duty session and loop. Take their terminals from `~/.dori/harness/roles.json` (`duty`, `duty-loop`), then `hc kill` and `hc rm` each.
2. Restore `ensure-lead.sh` from the backup (drop the `dori up` line) before launchd runs it again; otherwise it starts them again.
3. `cd ~/.dori/src/skills/dori-mode/scripts && bun link`. This relinks the old package, so `~/.bun/bin/dori` points to the old CLI with its hc patch again. Check with `readlink ~/.bun/bin/dori`, and remove the extra `~/.bun/bin/dori-mode` link.
4. Restore `monitors.json` and `LEAD.md` from the backup. Stop the duty-watch monitor, and re-arm the dead-pane and freshness monitors (and the done watcher and host guard) as in step 9.
5. Tell the lead to re-read LEAD.md.
6. `~/.dori/state` stays readable by the old code: the lane files only gained optional fields. `~/.dori/harness` can be deleted.
7. If step 12 already ran, revert that commit in the skills repository and sync again.

## The other machines

A second Mac and a Linux VPS each run their own Dori-mode lead on hc, with the same local hc patch (the VPS copy carries an extra Linux-specific change). Move them one at a time, after the first machine has run a day without trouble:

- Use the same steps, run on that machine (`hc exec --on <machine> ...` or ssh), with that machine's own config, LEAD.md, monitors file and restart scripts. The duty session and loop open in that machine's own lane space; `dori up` there needs that machine's `DORI_AGENT_CMD`.
- On the VPS:
  - Diff its local patch against this repository before step 3, and keep whatever the new code does not already cover. The host guard already reads `/proc/loadavg` on Linux.
  - Its lead watchdog is not launchd. Add the `dori up` line to whatever restarts that lead there (a systemd timer or cron job); without one, the lead's duty-watch monitor is the only path that notices a dead loop.
- Do not restart the hc server on either machine. On the second Mac the server runs inside a terminal app that holds the screen-recording and accessibility permissions; computer use depends on that.
- Run step 12 only after the last machine has switched.
