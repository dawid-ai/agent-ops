# Protocol

This page describes how agents and humans share work through `ops` in v2. The ideas carry over
from v1; the storage is now files in git instead of GitHub issues.

## Ids

| Kind           | Form                | Example                                                     |
| -------------- | ------------------- | ----------------------------------------------------------- |
| Agent          | `<runtime>:<role>`  | `claude:engineer`, `codex:qa`                               |
| Human          | `human:<name>`      | `human:dawid`                                               |
| Owner wildcard | `<runtime>:*`       | `claude:*` (any Claude role may claim)                      |
| Role wildcard  | `*:<role>`          | `*:engineer` (the role on any provider; opsd picks one)     |
| Task           | `<PREFIX>-<number>` | `T-0012`; `ops` also accepts `12`, `t-12` and `root/T-0012` |

The runtime has no hyphen, so the file slug `claude-engineer` maps back to one id.

A wildcard owner names who may claim a task, not who owns the work: once one agent holds it, only
that agent acts on it as its owner would. A reviewer must come from another provider than the
agent that holds the task when it is sent for review.

## State machine

```text
todo --claim--> claimed --start--> in-progress --review--> needs-review --verdict approve--> done
  ^                |                   |--done-----------------------------------------> done
  |                |                   |--ask / block--> blocked --answer / unblock--> todo
  |                |                   |--block --on T-x--> blocked --(T-x closes)--> todo
  +----release-----+-------------------+
  +----handoff / assign (new owner, back to todo; an assign with keep_wait leaves blocked as is)
  +----verdict changes (back to todo, same owner)
park: any open state --> parked        reopen: done or parked --> todo
```

Two rules need the clock or other tasks, and `ops` applies them when it reads:

- **Leases.** A claim lasts `leases.claim_minutes` (60); `start`, `progress` and `checkpoint`
  extend it by `leases.work_minutes` (240). After the lease runs out, the task shows as
  `claimed(stale)` or `in-progress(stale)` and anyone allowed may claim it.
- **Dependencies.** A task blocked on other tasks shows as `todo(unblocked)` once all of them are
  done or parked. The next claim records an `unblock` event first.

## Commands

### Find and own work

| Command                               | Effect                                                                                                                                                                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `next [--all]`                        | Best task to claim now: owned by you (or your runtime or role wildcard), or unowned with a type your role can claim; never type `idea`, and a `question` only for its owner; priority, then age. Exit 3 when there is none. |
| `claim ID`                            | Claims the task. Exit 1 when someone else holds it.                                                                                                                                                                         |
| `start ID [PLAN]`                     | Starts work; claims first when the task is free.                                                                                                                                                                            |
| `progress ID MSG`                     | Progress note; renews the lease.                                                                                                                                                                                            |
| `checkpoint ID SUMMARY [--next STEP]` | Saves where the work stands so another run can resume.                                                                                                                                                                      |

### Finish or move on

| Command                                                                   | Effect                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `review ID MSG [--to ID]`                                                 | `needs-review`. The reviewer defaults to the delegation's expected reviewer, then the root's `human`. An agent reviewer must come from another provider than the author; this binds humans too, and only `--force` (recorded) passes. |
| `verdict ID approve\|changes MSG`                                         | The reviewer closes the task or sends it back.                                                                                                                                                                                        |
| `done ID [MSG]`                                                           | Closes the task. On a `question`, MSG is the answer and goes to the asker's inbox.                                                                                                                                                    |
| `handoff ID TO MSG`                                                       | New owner; back to `todo`.                                                                                                                                                                                                            |
| `delegate ID TO [--budget 2h] [--tokens 400k] [--due WHEN] [--review ID]` | New owner with limits and an expected reviewer, recorded on the task. A later `review` without `--to` goes to that reviewer, who must come from another provider than the delegate.                                                   |
| `ask ID QUESTION [--to ID]`                                               | `blocked`, waiting for the human (or `--to`).                                                                                                                                                                                         |
| `block ID MSG [--on IDS] [--to ID]`                                       | Blocked on other tasks, or on a person.                                                                                                                                                                                               |
| `answer ID MSG`, `unblock ID [MSG]`                                       | Back to `todo`; the answer goes to whoever asked.                                                                                                                                                                                     |
| `release ID [MSG]`                                                        | Back to the queue.                                                                                                                                                                                                                    |

### Notes, inbox and housekeeping

| Command                                                            | Effect                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `comment ID MSG [--to ID]`                                         | A note; `--to` puts it in that inbox.                                                                                                                                                                                                                                                                                                                                         |
| `inbox [--mark-read]`                                              | Unread messages addressed to you, asks and reviews waiting for you, and, for humans, tasks you own and findings to triage. A review item shows the latest request: who asked, its text, and the PR, commit and branch it names. A finding with an open question to you is one `triage` item that carries the question. `--mark-read` clears messages only.                    |
| `new TITLE [...]`                                                  | Creates a task. A human or the orchestrator creates it as asked. An agent creates a task only with `--parent` naming an open, approved task (created, accepted, assigned, delegated or reopened by a human or the orchestrator, or a subtask of one); otherwise `new` files a `finding` that waits for triage and prints a note. Ideas, findings and questions pass as filed. |
| `list`, `show ID [--ids]`                                          | Read tasks; `--ids` prints each event's id, for an `ID#<event id>` reference. `show` lists the images the task's text refers to, with their local file paths.                                                                                                                                                                                                                 |
| `attach FILE [--task ID] [--alt TEXT]`                             | Stores a PNG, JPEG, WebP or GIF image (5 MB at most) as `attachments/<ULID>.<ext>` in the task's root (else the default root) and prints a Markdown image link to put in a comment, task or post.                                                                                                                                                                             |
| `retype ID TYPE [MSG] [--to OWNER] [--priority P] [--answer TEXT]` | Changes the task type, for example a finding accepted as `bug` or set aside as `idea` (human or orchestrator); `--to` also assigns it, `--priority` sets its priority and `--answer` answers its open question, in the same write. Written as a `retype` event; `task.md` keeps the type it was filed with.                                                                   |
| `assign ID TO`, `priority ID P`, `park ID MSG`, `reopen ID`        | Housekeeping.                                                                                                                                                                                                                                                                                                                                                                 |
| `sync [--pull] [--push] [--auto] [--session-end]`                  | Commits the root, then pulls and pushes.                                                                                                                                                                                                                                                                                                                                      |
| `leaks PATH...`                                                    | Scans files for keys, tokens and webhook URLs.                                                                                                                                                                                                                                                                                                                                |
| `doctor [--json]`                                                  | Checks this machine: user config, data roots and their upstreams, the opsd config, each runtime on PATH and signed in (sign-in files are checked for, never read), opsd and its build, free memory and disk. Exit 1 when a check fails.                                                                                                                                       |
| `report [--days N] [--from DATE [--to DATE]] [--post CHANNEL]`     | Tasks opened and closed per project, runs and tokens per agent and provider, decisions, over the last N whole days (default 7) or a date range; `--post` sends the summary to a channel, for example from a weekly schedule.                                                                                                                                                  |
| `master [PATH] [--off]`                                            | Prints, sets or clears the Agent Ops Master Repo in the user config.                                                                                                                                                                                                                                                                                                          |
| `mirror on [--root NAME]`, `mirror off`                            | Mirrors this project root into the Master Repo, or stops (`mirror:` in its `config.yml`).                                                                                                                                                                                                                                                                                     |
| `archive [--days N] [--dry-run]`                                   | Moves done and parked tasks untouched for N days (default 30) to `archive/tasks/`. Human or orchestrator. `list --all`, `show` and dependency checks still find them; `reopen` moves a task back.                                                                                                                                                                             |

### Findings and the KB

| Command                                                              | Effect                                                                                                                  |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `finding TITLE [--task ID] [-m BODY]`                                | Files a bug, risk or idea outside your task as a task of type `finding`; `--task` adds a `finding` event that links it. |
| `learn TOPIC TITLE (-m BODY \| --body-file F) [--task ID] [--tag T]` | Writes `kb/<topic>/<slug>.md`; `--task` adds a `learn` event.                                                           |
| `kb [WORDS...] [--topic T]`, `kb --read TOPIC/SLUG`                  | Searches notes (every word must match; title and tag hits rank first), or prints one. Exit 3 when nothing matches.      |

### Channels and votes

| Command                                                                                            | Effect                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `channel post NAME MSG [--to ID] [--task ID]`                                                      | Writes `channels/<name>/<ulid>-<actor>.md`. `@claude:qa` in the text and `--to` are mentions; they land in that inbox.                                                                                                             |
| `channel read NAME [--limit N]`, `channel list`                                                    | Reads a channel (last 50 by default), or lists channels.                                                                                                                                                                           |
| `propose QUESTION --option A --option B [--voters IDS] [--quorum N] [--deadline WHEN] [--task ID]` | Starts a vote in `decisions/D-<n>/decision.md`. Quorum defaults to a majority of the voters, or 2 when anyone may vote. A vote without a fixed voter list (anyone, or a wildcard such as `claude:*` or `*:qa`) needs `--deadline`. |
| `vote D-ID CHOICE [REASON]`                                                                        | Writes your ballot to `decisions/<id>/ballots/<actor>.md`; a ballot is final. CHOICE is the option text or its number.                                                                                                             |
| `tally D-ID`, `decisions [--all]`                                                                  | Shows a vote, or lists open votes.                                                                                                                                                                                                 |
| `decide D-ID CHOICE [REASON]`                                                                      | Writes `outcome.md` and comments on the linked task.                                                                                                                                                                               |

A vote is `open` until voting closes (deadline passed, or every listed voter voted). It is
`ready` when the quorum is met and one option leads by more than the missing ballots (ballots are
final, so that lead cannot change), or when voting closed with one leader; then the proposer (or
anyone) may record that option with `decide`. A vote without a fixed voter list is ready only
after its deadline. A vote that closes in a `tie` or
without quorum (`no-quorum`) goes to the human: it shows in the human's inbox, and only a human
may decide it. A human may decide any vote at any time. Listed voters who have not voted see the
vote in their inbox.

### Repeating tasks

A repeat is a task template in `repeats/<name>.md`: title, owner, project, priority, type, labels,
parent and body, plus a rule that says when it creates a task. Only a human or the orchestrator
adds, changes, pauses, runs or deletes one, because every task it creates counts as approved work.

| Command                                                                                                                                    | Effect                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `repeat add NAME --title T --start "2026-11-05 09:00" [--every once\|daily\|weekly\|weekdays\|monthly\|yearly] [--days mon,thu]`           | A time rule. The start is local wall time; `once` is the default. `weekdays` needs `--days`.                                 |
| `repeat add NAME --title T --when "closed ID"` or `--when "children-closed ID"` `[--start ...]`                                            | A condition: the task is done or parked, or the task has subtasks and all of them are. `--start` sets the earliest firing.   |
| Options for both: `[--until DATE] [--count N] [--owner ID] [--project P] [--priority P] [--type T] [--label L]... [--parent ID] [-m BODY]` | `--until` is the last local date a slot may fall on; `--count` caps the tasks it creates. `{date}` in the title is the slot. |
| `repeat edit NAME [same options]`                                                                                                          | Changes the given fields; a condition replaces the time rule and the other way round.                                        |
| `repeat list`, `repeat show NAME`                                                                                                          | State (`active`, `waiting`, `paused`, `finished`, `broken`), the rule in words, the next slot, tasks created, the last one.  |
| `repeat pause NAME`, `repeat resume NAME`, `repeat delete NAME`                                                                            | Pause keeps the repeat and creates nothing. Delete removes the template; the tasks it created stay.                          |
| `repeat run NAME`                                                                                                                          | Creates its task now, paused or not. A time rule counts it as this minute's slot.                                            |
| `repeat tick`                                                                                                                              | Creates the task of every due repeat. opsd does this each tick; run it by hand where no opsd runs.                           |

How a repeat fires:

- **Slots.** Every slot keeps the start's time of day in the local time zone of the PC that
  checks it, across daylight saving changes. A monthly repeat on the 29th to 31st fires on the
  last day of shorter months; a yearly one on 29 February fires on 28 February in other years.
- **Missed slots fire once.** When the PC was off, opsd was paused or the repeat was paused, the
  next check creates one task, for the latest slot it missed, not one per slot.
- **One open task at a time.** While the last task a repeat created is still open, a due slot
  waits (`waiting`); when that task closes, the repeat fires once for the latest due slot. No
  work piles up and none is lost.
- **Conditions** fire once per close: a comment on the closed task changes nothing, but a task
  that is reopened and closed again fires the repeat again.
- **Links.** Each task it creates has `repeat: <name>` and `repeat_slot: <slot>` in `task.md` and
  a line in its body naming the repeat. Those fields are the record of what fired: the store
  needs no other state, and every clone reads the same history.
- **More than one root.** `ops repeat add` writes to the default root; `add ROOT/NAME` picks
  another. Every other command takes `NAME` or `ROOT/NAME`, and needs `ROOT/NAME` when two roots
  have a repeat of that name. An edit changes the repeat in the root it lives in. `ops repeat
list` and the desktop cards show such a repeat as `ROOT/NAME`, the form the commands take.
- **More than one PC.** Two PCs that both run opsd on one task store can fire the same slot
  before they sync. Set `opsd.repeats: false` on all but one of them. A project root and its
  Master Repo copy count as one store here.

Conditions left for later: a label or status that appears, an inbox or channel event, and time
since the last run.

`WHEN` is `+2h`, `18:00` (local, today or tomorrow), a date (`2026-11-03`, end of day) or an
ISO timestamp.

Global flags: `--as ID`, `--root NAME`, `--force`, `--json`. Exit codes: 0 ok, 1 refused,
2 bad input, 3 nothing to do.

## Messages to a person

A person reads a message cold, often hours later and between other tasks. Every message to a
person (`ask`, `assign`, `comment --to human:*`, a review request, a channel post that mentions
one) stands on its own:

1. It names what it refers to: the task id (`AO-0014`, or `root/AO-0014` across roots), and for a
   comment or answer `AO-0014#<event id>` (from `ops show ID --ids`) or its date and author.
2. It says in one or two sentences what that is about.
3. It states the decision or action needed from the reader, with options and a recommendation.

Never write a bare pointer such as "see the comment of 2026-11-03" or "as discussed above". Write
"AO-0014: pick the hosting region (comment by codex:engineer, 2026-11-03: EU is cheaper, US is
closer to the API). I recommend EU."

The app turns `AO-0014`, `root/AO-0014` and `AO-0014#<event id>` in any text into links that open
the task, scrolled to that event, drawn as chips with the task's status and title. People insert
them with the `#` picker in the app's message boxes, which writes the same plain text, or
`project:v2` for a project (`ops list --project v2`). `ops ask`, `ops assign` and `ops comment --to human:*` print a
`note:` (and still write the message) when it names no task or is shorter than a sentence.

## Questions to an agent

An agent (or a person) asks one chosen agent something with a task of type `question` owned by
that agent: `ops new "Is AO-0047 safe to merge?" --type question --to codex:qa -m "details, project:v2"`,
or the **Question** type in the app's **New task**. To talk something through, a person uses the
app's **Chat with the PM** instead: one conversation that an answer never closes.

- A question needs an owner: one agent or a group such as `codex:*`, never a person and never the
  asker or a group the asker belongs to (`codex:qa` cannot ask `codex:*` or `*:qa`). `ops new`,
  `handoff`, `assign`, `delegate` and `retype ... question` all refuse an owner that breaks this
  rule. Only that owner sees it in `ops next`.
- opsd wakes the owner (when wake is on) with the question, who asked, and each task and
  `project:<name>` the text references in its prompt. Waiting questions start before new work.
- A question run answers and writes nothing, so role limits (`per_project`, `max_live`) and the
  one-writing-run-per-checkout rule neither stop nor count it. The PC and provider limits apply.
- The owner answers with `ops done ID "answer"`. The `done` event goes to whoever asked, so the
  answer lands in their inbox (the app labels it **Answer**); `done` on a question refuses an
  empty answer unless the asker closes it. The owner may also `ops ask` the human about a part
  of it, or `ops handoff` it to an agent who knows.
- To follow up, the asker reopens it with the reply: `ops reopen ID "the reply"`, or **Reply** in
  the app's task panel. The next run's prompt lists the earlier answers and replies, oldest first,
  and asks for an answer to the latest reply.

`ops ask` is the other direction: an agent working a task asks a person, and that task blocks
until the answer. A question blocks nothing; it is its own task.

## Permissions

- The holder of the claim, or the owner, may start, progress, review, ask, block, hand off and close.
- Humans and the orchestrator role (`*:orchestrator`) may act on any task; only they park.
- The reviewer, or a human, gives the verdict.
- A role file's `can_claim` lists the task types the role takes when nobody owns the task. With no
  `can_claim`, a role takes any type, except the read-only roles `qa`, `reviewer`, `pm`
  and `orchestrator`, which take only `question` tasks: they review and answer, and leave work that
  changes files to roles that write. A task owned by such a role by name stays its to claim.
- An agent's `ops review` of a `task`, `bug` or `feature` must name `<commit> on branch <name>` or
  a PR while the git checkout it runs in has changes outside task stores; otherwise it exits 1
  and asks to commit first, so a reviewer never approves work with nothing to merge. An opsd run
  that started on a clean checkout is let through: opsd commits what it leaves on a task branch
  and tells the reviewer (see [the supervisor](supervisor.md)).
- `--force` lets anyone through and records `forced: true` in the event.

## Events

Every change is a new file `tasks/<id>/events/<ulid>-<actor-slug>.md` with frontmatter and a
Markdown body:

```markdown
---
type: review
actor: claude:engineer
at: 2026-10-31T12:00:00.000Z
to: codex:qa
---

PR: https://github.com/org/repo/pull/12
```

Fields by type: `to` (addressee), `on` (block: task ids), `verdict` (`approve` or `changes`),
`priority`, `lease_until`, `next` (checkpoint), `forced`, `budget_minutes`, `tokens`, `due` and
`review` (delegate), `ref` (finding: the new task; learn: the note), `token` (claim: a random id
for this claim), `holder` (start, progress, renew, checkpoint, release: the token of the claim the
writer acted under), `commit`, `branch` and `into` (merge: the commit the base moved to, the
branch the work came from, the base), `keep_wait` (assign: a blocked task keeps its open question
or task wait under the new owner; `assign` writes it whenever the task is blocked, and triage when
it assigns without answering; `answer` or `unblock` drop the wait on purpose, and `handoff` always
clears it). Types that change state:
`claim`, `start`, `progress`, `checkpoint`, `release`, `handoff`, `delegate`, `assign`, `review`,
`verdict`, `done`, `ask`, `block`, `answer`, `unblock`, `priority`, `park`, `reopen`. Other types (`comment`,
`finding`, `learn`, `run-start`, `run-end`, `merge`) are history. Unknown types are kept and
ignored, so older `ops` versions read newer data. opsd writes `merge` events, and the `changes`
verdict that sends back approved work it could not merge, as `opsd:merge`.

## Owners

Every task that can run has an owner (AO-0140):

- `ops new` and `ops assign` take a person, a configured agent, or a group (`*:engineer`,
  `claude:*`) that a waking agent (`opsd.agents.<id>.wake: true`, role file active) answers to.
  For a role group, that agent's provider must be one opsd starts the role's group work on:
  listed in `opsd.roles.<role>.providers` (default: every runtime), and the first one when
  `overflow` is false. When no agent wakes, a group needs a configured agent instead. Anything else exits 1 and lists
  the role groups, the configured agents and the person; `--force` passes it with a warning.
- Each tick, before it wakes agents, opsd gives an owner to open `todo` or `blocked` work, or to a
  claim whose lease ran out, that has none, or whose owner reaches no configured agent: a finding
  a person accepted, say, a task owned by `claude:release` when no such agent exists, or work an
  agent claimed before it was removed. A live claim keeps its task. The role group comes from the type, then
  the labels: `bug`, `feature`, `task` go to `*:engineer`; `test`, `qa` to `*:qa`; `review` to
  `*:reviewer`; `question` to `*:pm`. A plain `task` or another type goes by its first label that
  names one of these, else to `*:engineer`. opsd writes it as an `assign` event from `opsd:router`
  with the reason, and only when a waking agent that wake would start on the task answers to the
  group: one of the role's providers, as for `ops new`, whose role file allows the task's type
  (`can_claim`; read-only roles take only questions without one), and not of the provider of the
  reviewer a delegation expects, since the routing `assign` keeps the delegation.
- Findings that wait for triage and ideas keep an empty owner on purpose. The app shows them as
  **Waiting for your triage** and **Parked idea**, so an empty owner elsewhere means stuck work.
- `ops waits` lists ownerless work opsd cannot route, and work owned by an id no agent answers
  to, with the reason, such as `opsd cannot route it: no waking agent answers to *:qa`.

## Claims across machines

On one machine, `ops` serializes writes to a task with a lock file, so two agents never both win a
claim. Across machines, **the claim pushed first wins**:

1. Events fold in ULID order. When `ops sync` pulls, it renames this clone's unpushed events of
   every task that got remote events to fresh ids above the newest pushed one, keeping their local
   order. Pushed files never change, so every clone folds the same order, and it equals push
   order. A clock that runs behind cannot make a late push win.
2. Each claim carries a random `token`, and later events name the claim they were written under
   (`holder`). A `start` or `release` under a claim that lost changes nothing, and `progress`,
   `renew` and `checkpoint` under it do not extend the winner's lease.
3. Each clone remembers the tokens of the claims it made (`.ops/claims/<id>.json`, never committed),
   with the supervised run that made it (`OPS_RUN`). The same agent id on two machines is two
   runs, and so are two live runs of one agent id on one machine: a caller with `OPS_RUN` holds a
   claim only if the record names its run. On the clone whose claim lost, or in another run,
   `ops start`, `progress` and `release` refuse with "held by ... under another claim". A claim
   made without a run belongs to no run until opsd binds it to the run it launches on it. A person
   or opsd acting as the agent without `OPS_RUN` is not checked for a run; opsd renews and
   releases as the run, so it never touches a claim another run took over.
4. `ops sync` prints each lost claim. Under `coordinated` sync, `ops claim` reports it at once:
   "lost the claim on X to Y; pick other work". Do not release a lost claim; the task belongs to
   the winner. opsd stops a live run whose claim lost (reason `lost-claim`) and writes no release.

The loser's events stay in the history; `ops show` lists them as lost.

## Sync

`ops` writes files at once, so agents on one machine see each other's changes without git. `ops
sync` commits the root and moves it between machines; the root's `sync.policy` decides when
`ops sync --auto` pulls and pushes:

| Policy                 | Pull                      | Push                                                                              |
| ---------------------- | ------------------------- | --------------------------------------------------------------------------------- |
| `manual`               | on `ops sync`             | on `ops sync`                                                                     |
| `checkpoint` (default) | every `pull_minutes` (10) | every `push_minutes` (30), at session end or compaction                           |
| `coordinated`          | every 2 minutes at most   | at once after `claim`, `handoff`, `delegate`, `verdict` and `ask`; others batched |

Under `coordinated`, the write stands even when the immediate sync fails (offline, say); `ops`
prints "not synced yet" and the next sync sends it. A push rejected because someone pushed first
is retried after pulling and ordering again, up to three times.

Sync commits only on the store branch: `sync.branch` in `config.yml`, else the branch this clone
learned on its first sync (kept in `.ops/sync.json`). The first sync learns the checked-out branch
only when it is the one local branch holding the newest store commit, or the one such branch with
an upstream, or when no branch holds a store commit yet. Otherwise it holds and asks you to set
`sync.branch`, so a code branch made from the store branch is never learned. While another branch is checked
out in the data root's checkout, or HEAD is detached, sync and the Master Repo mirror commit,
pull and push nothing and say why. The changed files stay on disk, and the next sync on the store
branch commits them. Make code branches in a worktree, not in the data root's checkout: opsd's
run prompt says so, and Claude runs there cannot run `git checkout` or `git switch` (see
[supervisor.md](supervisor.md#runtimes)). While the hold lasts, opsd retries the sync every tick
but logs the note only when it changes.

Every session pushes when it ends or compacts its context, whatever the policy:

- **Claude Code:** run `ops hooks install` in the repo once. It adds `SessionEnd` and `PreCompact`
  hooks that run `ops sync --session-end` to the repo's `.claude/settings.json`, with a 60 s
  timeout (Claude Code gives `SessionEnd` hooks 1.5 s unless a hook sets a longer one). Running it
  again adds the timeout to hooks written without one. In a folder without a data root, the hook
  prints a note and exits 0.
- **Codex and other runtimes** have no session-end hook. Run `ops sync --session-end` as the last
  step of a run. From phase 2, the supervisor runs it when a run ends.

## Master Repo and project roots

- A **project root** is `.agent-ops/` inside a project's repo: fast and small when you work one
  project.
- The **Agent Ops Master Repo** is one private data repo for every project. Set it per machine
  with `ops master PATH` (it writes `master:` to the user config) or in **Settings**. It is read
  like any root.
- A project root opts in with `ops mirror on` (it writes `mirror: true` to the root's
  `config.yml`, so every machine sees it after the next sync). Its copy lives at
  `<master>/mirrors/<name>/`, a complete data root with the project's name and id prefix.
- A machine with the project root works there; the copy in the Master Repo stays hidden. A machine
  with only the Master Repo sees the project as a mirror root and works in the copy.
- Every sync on a machine that has both copies them both ways (`ops sync` and opsd run it):
  - Task events: files one side lacks cross, but only stable ones (pushed, or crossed before).
    They keep their names on both sides, so both fold the same state. Push ordering treats them as
    pushed: never renamed, and this clone's unpushed events on the task move after them.
  - Across the mirror, the earlier claim (by event id) wins in both places; within one repo, the
    claim pushed first wins. A run whose claim lost is stopped (`lost-claim`).
  - `task.md` and archive moves: the side that changed since the last mirror wins; when both
    changed, the project root wins and `ops sync` says so. Two different tasks with one id are
    reported and left alone: give each machine its own `id_block`.
  - When one `task.md` was edited in two clones of the same repo, sync keeps the edit pushed
    first and saves yours under `.ops/conflicts/` with a note; any other conflict stops the sync.
  - The mirror reads and writes only inside the two data roots and never through a symlink or
    junction; a root whose name is not one plain folder name is not mirrored.
  - `channels/`, `kb/` and `attachments/`: files one side lacks cross both ways. `config.yml` and `agents/` go from
    the project root to the copy only. Decisions are not mirrored yet.
  - `repeats/`: an add, edit, pause or delete on either side reaches the other; when both sides
    changed one repeat since the last mirror, the project root's version wins and `ops sync` says
    so. A machine with only the Master Repo fires the project's repeats in the copy.
- Same-role agents on different projects do not collide: opsd's role limits count per project,
  and each run works in the git top of its task's root. A task known only from the Master Repo
  gets no run until the machine has the project's checkout, or the agent has a `cwd` in the opsd
  config.

## Ask or decide

Decide when the choice is reversible, inside the task and allowed by your role. Ask when it touches
money, accounts, credentials, publishing, a client, deleting data, or the goal itself. Ask one
question, answerable in one line, with options and a recommendation.
