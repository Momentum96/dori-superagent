<p align="center">
  <img src="skills/dori-mode/assets/dori-avatar.png" alt="Dori" width="120">
</p>

# dori-superagent

A proactive multi-session coding-agent harness in about 660 lines of TypeScript, running on [herdr](https://github.com/herdrdev/herdr) and [omo](https://github.com/code-yeongyu/oh-my-openagent).

English | [한국어](README.ko.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

One lead session talks to you. Each task runs as a lane: its own omo session in its own herdr tab, started from a written brief and finished with a READY that must carry evidence. A duty loop nudges lanes that go quiet, escalates to the lead, and holds messages for busy panes until they can read them. Merges pass through a gate that requires a CLEAR review receipt at the exact head plus green checks.

## Why this exists

DeepSeek published [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) (first commit 2026-10-31) and, about a day later, the article "Exploring Super-agent Design: Towards a More Autonomous Agent System". Their design has a long-lived Router session that only talks to humans and dispatches work, isolated Worker sessions with one per ticket, event triggers batched per turn, and a watchdog. Their README calls it a research prototype, and its stated philosophy is to "take as little human attention as possible, and give as much value as possible".

We have been running the same shape for about six months, in public:

- 2026-04-18: team mode lands in omo, several agent sessions in terminal panes with a worktree each ([f1268c0](https://github.com/code-yeongyu/oh-my-openagent/commit/f1268c0), [e303fee](https://github.com/code-yeongyu/oh-my-openagent/commit/e303fee)).
- 2026-05-06: the Dori name enters the omo README ([#3807](https://github.com/code-yeongyu/oh-my-openagent/pull/3807)).
- 2026-10-07: this repository publishes Dori mode, as `omo-dori-mode-experimental` ([ce53e4d](https://github.com/sisyphuslabs/dori-superagent/commit/ce53e4d)): one agent hands each job to its own agent session in a herdr tab and closes it only after the work is done. The git history is public.
- 2026-10-31: DeepSeek's prototype gets its first commit.
- Around 2026-11-01: DeepSeek's article.

It is how we work every day. omo has 70k+ stars. Over the 31 days from 2026-10-03 to 2026-11-02, the [author's GitHub contribution calendar](https://github.com/code-yeongyu) shows 38,656 contributions: about 1,250 a day on average, with peaks of 2,227 on 2026-10-16 and 2,001 on 2026-10-29. That is up to ~2,000 contributions a day, produced with the full version of this setup.

The harness at the root of this repo is the minimal version: the part that runs on herdr and omo alone, with nothing else attached.

## Same structure, same philosophy

Put DeepSeek's prototype docs next to Dori and the concepts line up one for one, in the structure of the pipeline and in the rules of their [philosophy doc](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/000-philosophy.md).

![Dori vs DeepSeek](docs/dori-vs-deepseek.en.png)

### Structure

| DeepSeek dsh-superagent | Dori |
|---|---|
| Source: GitHub, Feishu | Dori lives in chat: Slack, Discord, Telegram |
| Trigger, then Eval, then Ticket | One task asked in chat becomes one ticket |
| Executor session per ticket: one session, one work directory | One coding-agent session per task, run on omo, many in parallel |
| Channel: answers in the original conversation, with a PR for example | Reports in the same channel, one status message per task, edited in place |
| Panel: shows only what needs a person | The ticket board and Notion stay current on their own |

### Philosophy

| DeepSeek dsh-superagent | Dori |
|---|---|
| Least human attention, most value | Short messages, no emojis, a ping only after the merge |
| Acts only when asked or when a written team rule allows it | People set direction and bring new ideas; Dori starts no work nobody asked for |
| Speaks only when a person must act, one question at a time | A decision comes with options, its own recommendation and one picture |
| Reports honestly, never works around a block | No "done" without proof; checked against a real case, and the report is the merged result |

The Dori column is our production Dori and Dori mode (`skills/dori-mode`). The harness at the root of this repo implements its lane, inbox, duty and merge-gate part on herdr and omo.

## Architecture

![architecture](docs/architecture.png)

Three roles, each an omo session in a pane (herdr, or herdr-core `hc`). The multiplexer recognises omo as an agent and reports its state (idle, working, blocked, done). dori reads that state before it does anything to a pane, and never types into a pane on hc that runs no agent.

The lead is the only session that talks to you, on the one channel you use: its own pane, or a messenger when the lead is a Dori-mode session. It turns a request into a brief, opens a lane with `dori start`, reads what lanes send back, and merges. `dori up` never starts a second lead: the lead is `leadPane` in `~/.dori/config.json` (or `dori role lead`), and only when neither is set does `dori up` open one.

A lane is one omo session in its own tab (on hc, its own terminal), opened from one brief with the lane footer appended. `dori start` is Dori mode's `dori launch` plus a `[START]` to the lead, so every lane is in one registry (`<stateDir>/lanes`, `~/.dori/state` by default) whichever command opened it. It reports milestones with `dori report`, which records the line on the lane and delivers it to the lead, and finishes with `dori ready`, a done claim that refuses to go out without an evidence link.

The duty loop is `dori duty --interval 60`, a plain process in a pane next to a duty omo session. Each tick it delivers queued messages to panes that have become idle agents, reports a lane whose pane vanished as `[LOST]`, runs Dori mode's freshness sweep (the only nudger: it nudges a silent lane once and posts its last recorded report to the lane's thread), runs the dead-pane sweep and hands dead panes to the duty session, escalates a nudge the lane never answered as `[ESCALATE]`, and writes a heartbeat. `dori duty-watch` turns a stale heartbeat into `DUTY_STALE`, and `dori up` is safe to run every minute: it revives the duty session, replaces an idle one that runs an older agent than the one installed, and replaces a loop whose heartbeat stopped.

Lanes are JSON in Dori mode's registry. What only the harness has (roles, pane inboxes, rendered prompts, review receipts, the duty heartbeat) is under `~/.dori/harness` (or `$DORI_HOME`). The only long-running process the harness adds is the duty loop, and the only runtime dependency is Bun.

![lane lifecycle](docs/lane-flow.png)

`dori start <key> --brief FILE --done "SIGNALS"` appends the lane footer to the brief, opens a tab, starts the agent from the config's `agentCommand`, records the lane as `working`, and sends the lead `[START <key>]`. From there the lane reports (`[REPORT] <key> | <milestone|blocker|question|done> | <text>`) and ends with `[READY <key>]` plus its evidence links, which is a done claim: the watcher re-checks the Done signals and closes the lane, or the lead objects or closes it now with `dori done <key>` (refused unless every Done signal reads back live). The lead runs `dori review` and `dori merge` when there is a PR. A lane silent past `nudgeAfterMin` is nudged once; if it still says nothing it is escalated to the lead (`[ESCALATE <key>]`). A lane whose pane disappears before a done claim is reported as `[LOST <key>]`.

## Mapping to DeepSeek's super-agent

| DeepSeek super-agent | dori | In this repo |
|---|---|---|
| Router session: talks to humans, dispatches | LEAD session: the only one that talks to the human; opens lanes, merges | `prompts/lead.md`, `up()` in `src/cli.ts` |
| Worker session, one per ticket | LANE: one omo session per task in its own tab, with its own brief | `startLane()` in `src/harness.ts`, `launchLane()` and `footer()` in `skills/dori-mode/scripts/src/launch.ts` |
| Ticket + Mandate | brief file + lane footer with a checkable Done line, and a READY that must carry evidence | `ready()` in `src/harness.ts`, `claimDone()` in Dori mode's `done-flow.ts` |
| Trigger batching: events batched per turn | pane inbox: messages to a busy pane queue and arrive as one batch when it goes idle | `send()`, `flushInbox()` in `src/harness.ts`; `inbox/` in `src/store.ts` |
| Watchdog | DUTY loop: inboxes, LOST, freshness nudge and thread post, dead panes, one escalation, heartbeat | `dutyTick()`, `dutyWatchTick()`, `up()` in `src/harness.ts`, `prompts/duty.md` |
| Admission matrix, `maxWorkers` (default 3) | none here; `dori start` refuses only a key that is already open | `startLane()` in `src/harness.ts` |
| not in the prototype | gated merge: CLEAR review receipt at the exact head SHA plus green checks; an empty check list is never green | `review()`, `mergeGate()` in `src/harness.ts`, `prompts/review.md`, `receipts/` in `src/store.ts` |
| not in the prototype | one-voice rule: lanes and duty never talk to the human | `prompts/lead.md`, `prompts/duty.md`, the lane footer |
| not in the prototype | answer ledger: each lane's last report, done claim with its final answer and evidence, and status history kept on disk | `lastReport`, `claim`, `history` on the lane in Dori mode's registry |

## Quick start

You need Bun 1.3 or newer, herdr, omo, and the GitHub CLI `gh` (used for PR head SHAs, checks and the merge).

```sh
git clone https://github.com/sisyphuslabs/dori-superagent
cd dori-superagent
bun install
bun link   # puts `dori` on your PATH; or write `bun src/cli.ts` wherever `dori` appears below
```

Start herdr, then from a shell:

```sh
dori up
# UP LEAD started w1:p1 / UP DUTY started w1:p2 / UP LOOP started w1:p3
```

That opens a herdr workspace named `dori` with a lead pane (omo with `prompts/lead.md` appended to its system prompt), a duty pane (omo with `prompts/duty.md`), and the duty loop below it. Talk to the lead pane. It writes a brief (goal, inputs, deliverable, stop condition, constraints; see [`examples/brief.md`](examples/brief.md)) and opens lanes itself, and you can do the same from the shell:

```sh
dori start fix-flaky-login --brief examples/brief.md --done "merged owner/repo#12"
# STARTED fix-flaky-login pane=w1:p4 brief=/abs/path/examples/brief.md
dori status
# lead=w1:p1 duty=w1:p2 loop=w1:p3 beat=12s ago home=~/.dori/harness
# fix-flaky-login          working       w1:p4    heard 0m ago
```

A lane key matches `^[a-z0-9][a-z0-9._-]{1,60}$`, and a key that is already registered is refused.

Inside a lane, omo reports and finishes with the commands the lane footer hands it:

```sh
dori report fix-flaky-login --kind milestone --text 'reproduced: 1 failure in 20 runs, shared session fixture'
dori report fix-flaky-login --kind blocker --text 'waiting on checks for owner/repo#12'
dori ready fix-flaky-login --text 'root cause fixed in owner/repo#12, checks green' --evidence https://github.com/owner/repo/pull/12
```

The lead, on `[READY fix-flaky-login]`:

```sh
dori review owner/repo#12            # fresh omo reviewer pinned to the head SHA; writes a receipt; exit 0 on CLEAR
dori merge owner/repo#12 --dry-run   # MERGE_OK ... (dry run), or MERGE_REFUSED <why> with exit 2
dori merge owner/repo#12             # gh pr merge --squash --match-head-commit <sha>
dori done fix-flaky-login            # closes now; refused unless every Done signal reads back live
```

`dori send <lead|duty|key|pane> --text '...'` delivers a message to a pane, or queues it until the pane is an idle agent. `dori role <lead|duty> [PANE]` registers a pane by hand when you did not use `dori up`. `--text` can be left off to read the message from stdin. The commands the agents see are rendered with the full path to `src/cli.ts` and `DORI_HOME` set, so `dori` does not need to be on their PATH. Environment: `DORI_HOME` (state directory, default `~/.dori/harness`), `DORI_AGENT_CMD` (default `omo`), `DORI_HERDR_SESSION` (a named herdr session), `DORI_CMD` (how the agents are told to call dori), `DORI_MUX` (`herdr` or `hc`, see below).

### On herdr-core (`hc`)

The harness also runs on herdr-core. Set `DORI_MUX=hc`, or `"mux": "hc"` in `~/.dori/config.json` (the same file Dori mode reads). On hc every pane is a terminal (`t7`): lanes, the duty session and the duty loop open as `hc run --bg --outlive-parent` login shells, labelled with the Herdr app space from `DORI_HC_SPACE` or the config's `laneWorkspace`, and messages go in with `hc send`, only to a terminal whose agent reports a state: pasted into a plain shell they would run as commands, so they stay queued. hc reports the agent state itself, so `dori send` and the duty loop read `idle`/`working`/`blocked`/`done` from `hc get`. `src/mux.ts` is the seam; `src/herdr.ts` and `src/hc.ts` are the two implementations, and the lanes a session starts inherit its `DORI_MUX`.

## What the harness enforces

One voice. The lead is the only session that talks to you (`prompts/lead.md`). The lane footer tells a lane to report to the lead, and the duty session never merges and never talks to the human (`prompts/duty.md`). Everything a lane does reaches the lead pane as a prompt: `[START]`, `[REPORT]`, `[READY]`, `[LOST]`, `[ESCALATE]`.

READY needs evidence. `dori ready` refuses without at least one `--evidence` link and without final answer text (`ready()` in `src/harness.ts`). It records a done claim carrying both; the lane then closes only when every signal on its Done line reads back live, through the watcher or `dori done`.

Busy panes are never interrupted. `dori send` asks herdr for the pane's agent state first. `idle`, `done`, or (on herdr) a plain shell get the message now; anything else has it queued in `~/.dori/harness/inbox/`, and the command prints `QUEUED`. The duty loop delivers the queue when the pane goes idle, as a single message that starts with "N messages arrived while you were busy", oldest first (a `[START]` carries its lane's open time, so it comes before a report the lane sent while starting), and without an `[ESCALATE]` whose lane has since claimed done (`send()` and `flushInbox()` in `src/harness.ts`). `dori done` waits the same way: it refuses to close a pane that herdr reports as working or blocked.

One nudger. Dori mode's freshness sweep, run by the duty loop, nudges a lane that has been silent for `nudgeAfterMin` (15) once per silence, and after `postAfterMin` (20) posts the lane's last recorded report to its thread. A `dori report` resets the clock. If the lane still has not reported `nudgeAfterMin` after the nudge, the duty loop sends the lead one `[ESCALATE <key>]`. Nothing else nudges lanes, so a lane is never woken twice for the same silence.

Merge needs a CLEAR receipt at the exact head and green checks. `dori merge` reads the PR's head SHA with `gh`, then requires a receipt for that SHA in `~/.dori/harness/receipts/` with verdict `CLEAR`. Only `dori review` writes receipts. It runs a fresh non-interactive omo (`omo -p --no-session`, optionally `--model`) on `prompts/review.md` pinned to that SHA, and when the reviewer prints no `VERDICT:` line, no receipt is written. Then `gh pr checks` must return at least one check, every check must be `pass` or `skipping`, and at least one must be `pass`. An empty check list is refused with "an empty check list is never green". The merge itself is `gh pr merge --squash --match-head-commit <sha>`. A push after the review changes the head SHA, so the receipt no longer matches and the merge is refused (`review()` and `mergeGate()` in `src/harness.ts`).

## Dori mode (`skills/dori-mode`)

Dori mode is the messenger-facing half, published in this repository on 2026-10-07. It turns one coding-agent session into an always-on agent you talk to over a messenger. That session hands each job to its own agent session in a herdr tab, keeps a registry of every session it started, and closes one only after the work is proven done: a merged PR, a closed issue, a published version, or a check it can run itself. It ships as a skill (`skills/dori-mode/SKILL.md` plus `references/`) and its own Bun + TypeScript CLI, also called `dori`.

```sh
curl -fsSL https://raw.githubusercontent.com/sisyphuslabs/dori-superagent/main/install.sh | bash
```

That clones this repo to `~/.dori/src`, links the skill into `~/.agents/skills/dori-mode`, puts `dori` on your PATH with `bun link`, and copies an example config to `~/.dori/config.json`. Commands, configuration, routing and the done protocol are in [`skills/dori-mode/SKILL.md`](skills/dori-mode/SKILL.md) and its [`references/`](skills/dori-mode/references/).

There is one `dori` command. The harness CLI (`src/cli.ts`) runs Dori mode's commands (`launch`, `sync`, `watch`, `dead-panes`, `guard`, `freshness`, `can-launch`, `claim-done`, `object-done`, `close`, `pause`, `resume`, `heavy`, `presence`, `transcribe`, `inbound`, and `send` to `slack`, `telegram` or `discord`) by loading Dori mode's CLI in the same process; everything else is the harness. Dori mode's CLI is also on PATH as `dori-mode`. The harness's own prompts call it by the full path to `src/cli.ts`, so the agents it starts never depend on which `dori` is on PATH.

## What this is not

A minimal experiment. The harness is about 660 lines of TypeScript on Bun with zero runtime dependencies, and it is not our production stack. Left out on purpose: the cross-machine mesh, heavy-slot scheduling, the chat and ticket-tracker bridges, and receipts for whole test suites. What is here is the part that runs on herdr and omo alone: roles, lanes, the inbox, the duty loop, and the review and merge gate. Dori mode in `skills/dori-mode` is a separate CLI with its own messenger pieces, host guard and heavy-slot runner; the harness only hands it the commands it owns.

## Tests

`bun test ./test/` at the repo root runs the harness's 9 tests and calls no model. Plain `bun test` would also pick up the Dori mode tests.

Eight unit tests (`test/harness.test.ts`) run against a fake herdr (`test/fake.ts`): a recorder that stands in for the `herdr` and `gh` binaries, holds panes with a settable agent status, and has a clock the tests move. They cover lane start and READY, the queue-and-batch behaviour of a busy lead, refused unknown targets, nudges at 10 and 20 with escalation at 40 and WAITING lanes left alone, the working and lost states, every branch of the merge gate (no receipt, BLOCK, empty check list, a red check, all checks skipped, CLEAR plus green), and a reviewer with no VERDICT line.

One end-to-end test (`test/e2e.test.ts`) starts a real herdr server in an isolated named session, creates a workspace, registers a lead pane, and starts a lane whose agent is `test/fixtures/fake-agent.sh` in place of omo. The script reads its brief, calls `dori report` and `dori ready`, and the test checks that `[START]`, `[REPORT]` and `[READY]` arrive in the lead pane and that `dori done` closes the lane. It is skipped when `herdr` is not on PATH. `bun run typecheck` runs `tsc --noEmit`.

Dori mode has its own 68 tests, against fake herdr, git and gh:

```sh
cd skills/dori-mode/scripts && bun install && bun test
```

## License

MIT, see [LICENSE](LICENSE).
