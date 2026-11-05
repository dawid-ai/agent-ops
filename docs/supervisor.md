# Supervisor (opsd)

`opsd` runs once per machine. It starts agent runs, watches them, renews their claims, ends them
when they run over budget, runs schedules, wakes agents when work arrives, syncs the data roots, and
serves a local API for the desktop app. It replaces v1's `launch.sh`, `waitpids.sh` and `watch.sh`.

## Start and stop

```bash
ops daemon start            # in the background, no window; log in <state>/opsd.log
ops daemon status           # pid, port, version; exit 3 when not running
ops daemon stop             # runs keep going; the next opsd adopts them
ops daemon stop --kill-runs # also stop every run
ops daemon restart          # stop and start; live runs keep going and are adopted
ops daemon pause            # no new runs or schedules until resumed; live runs finish
ops daemon resume
ops daemon run              # in this terminal, until Ctrl+C
```

On Windows, Node puts each child it starts into a job object that ends the child when `opsd`
exits, and starting runs detached would leave them without a console, so their own console tools
would open visible windows. `opsd` starts each run there through a hidden `cmd.exe` that runs a
small launcher (`node -e`, with a fixed command line). The job lets that shell's children break
away, so the launcher runs outside the job and keeps the hidden console when the job ends the
shell.

1. The launcher sends its PID to `opsd` over a named pipe with a random name.
2. `opsd` reads the launcher's creation time while it waits, and saves its PID, image and
   creation time in the run record (`shim_pid` keeps the shell's).
3. Only then does `opsd` send the command, its arguments, its environment and the prompt. The
   launcher starts the command as its own child, in a kill-on-close job, and forwards the prompt
   to its stdin.

No argument passes through a `cmd.exe` command line, except for a `.cmd` or `.bat` runtime, which
`cmd.exe` must read: there, an argument with `"`, `%`, `!`, CR or LF is refused at launch. If
`opsd` exits, aborts the launch or fails to record the launcher, the pipe closes and the launcher
exits without starting anything. Killing the launcher ends the command too. A stop gives a run
still launching up to 5 s to finish, then ends it here and releases its claim, so every run
handed to the next `opsd` names a launcher it can adopt by PID and creation time.

`GET /api/health` reports `runs_outlive`. Where it is false, `opsd` refuses a stop or restart
without `--kill-runs` while runs are live (exit 1, nothing changes), and Ctrl+C on
`ops daemon run` ends the runs and releases their claims.

A stop waits up to 15 s for the old process to exit. If it is still alive, the stop fails and a
restart starts no second `opsd`.

A start waits up to 75 s for the new `opsd` to answer while its process runs, and stops waiting
as soon as that process exits. Before it answers, `opsd` reads process creation times (its own for
the lock, a stale lock holder's, and those of the runs it adopts); on Windows each read starts
PowerShell, which a loaded machine can hold up to its 15 s timeout.

A pause is `opsd.paused: true` in the user config, so it holds across restarts, and a stopped
`opsd` starts paused. While paused, `opsd` refuses every new run (wakes, schedules,
`ops launch`, **Run now**) with the reason in `ops waits`; helper runs of live runs still start.
Sync, notifications, presence and the API keep working.

The `opsd` command (`packages/supervisor/dist/main.js`) takes the same verbs. Start opsd from a
folder inside a data root, or list roots in the user config, so it finds the tasks.

State lives in `~/.agent-ops/opsd/` (or `OPS_STATE_DIR`) and is never committed:

| Path                 | Content                                                                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `opsd.json`          | pid, port and API token of the running opsd (mode `0600` on Linux and macOS)                                                                                                                                                         |
| `opsd.lock`          | PID and creation time of the running opsd; one opsd per state folder, even when two start at once. A lock is replaced only when its holder is certainly gone; if opsd cannot tell, it refuses to start and names the file to delete. |
| `opsd.lock.takeover` | held for a moment while a starter replaces a stale lock; never reclaimed automatically. If a start crashed while holding it, opsd refuses and names it.                                                                              |
| `opsd.log`           | the supervisor's own log                                                                                                                                                                                                             |
| `runs/<id>.json`     | one record per run: agent, task, pid, budget, tokens, outcome                                                                                                                                                                        |
| `logs/<id>.log`      | the run's output (Claude `stream-json`, Codex `--json`)                                                                                                                                                                              |
| `schedules.json`     | when each schedule last ran                                                                                                                                                                                                          |
| `wake.json`          | which inbox items each waking agent was last started for                                                                                                                                                                             |

## Runs

```bash
ops launch codex:engineer --task AO-0009 --budget 2h --tokens 400k
ops runs                    # live runs; --all for the last 30
ops logs 7Q2K               # end of a run's log; a run id or its last characters
ops kill 7Q2K               # stop the run and its process tree
ops procs 7Q2K              # every process the run started; --kill stops what an ended run left
ops usage                   # each provider's usage allowance, and whether it pauses new runs
ops waits                   # what waking agents could start, and why each waits (needs opsd)
ops spawn -m "look up X"    # inside a run: start a helper under the run's claim
ops procs 7Q2K --kill --pid 4120   # stop one of them, such as an unsure one you checked
```

A run with a task:

1. opsd checks the launch, then claims the task for the agent before the process starts, so two
   runs never race for it. If starting the process fails, opsd releases the claim it took.
2. It starts the runtime with the prompt on stdin, `OPS_AGENT`, `OPS_RUN`, `OPS_ROOTS`,
   `OPS_RUN_TOKEN` and `OPS_RUN_STATE_DIR` set, and writes a `run-start` event on the task. See
   [Run tokens](#run-tokens).
3. While the process lives, it renews the claim when less than half of the lease is left (a `renew`
   event), counts tokens from the log, and kills the run when it passes its time or token budget.
4. When the process ends, it writes a `run-end` event (exit code, reason, minutes, tokens). If the
   agent still holds the task, opsd releases it, so the task goes back to the queue at once instead
   of waiting for the lease to run out.

The budget comes from `--budget`, then the task's delegation (`ops delegate --budget`), then the
agent's `budget` in the opsd config, then the role file's `budget_min`, then `budget_minutes`
(default 180). The token budget comes from `--tokens`, then the delegation. Tokens counted are
input, cache writes and output; cache reads are left out.

### Runtimes

| Runtime  | Command line                                                                                                                                       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude` | `claude -p --permission-mode acceptEdits --output-format stream-json --verbose [--model M] --allowedTools ... --disallowedTools ... --add-dir ...` |
| `codex`  | `codex exec [-m M] --json --sandbox workspace-write --skip-git-repo-check -C <cwd> --add-dir ... -`                                                |
| other    | the config's `command` and `args`, prompt on stdin                                                                                                 |

- The providers come from the user config only, once it is seeded (`opsd.seeded`). `ops setup`,
  the desktop's first start and opsd's start write the defaults (`claude`, `codex`) once; a
  machine with no config file also gets the default agents (`engineer`, `qa`, `reviewer` and `pm`
  for each default provider found on PATH). A config from before seeding gets the defaults
  written on the next opsd start, with a note in the opsd log, and keeps every entry it had.
- The model of a run is the agent's `model` in the config, else its role file's `model`, else the
  provider's `model`. A model is one word that cannot start with `-`. Other runtimes get no model
  flag.
- A run of a provider the config does not list, such as one removed in Settings, does not start:
  `ops waits` and the launch error say `no provider '<name>' in Settings > Providers`.
- Claude's allowed tools are the role file's `tools` (or a default dev set) plus `Bash(ops *)`.
  Kills by name (`taskkill`, `pkill`, `killall`, `Stop-Process`), force pushes, and `Edit` or
  `Write` against any data root's `agents/` directory are always denied. A run of a role that does
  not write (`roles.<role>.writes: false`, the default for `qa`, `reviewer` and `orchestrator`)
  gets `Edit`, `Write` and `NotebookEdit` denied as well, even when its role file lists them.
- Role-file `mcp` fields are preserved metadata; the supervisor does not configure a run from them.
- Runs inherit opsd's environment and act as the human's accounts; task events record which agent
  did what. Codex's sandbox blocks network access and `.git` writes. A runtime's `unset_env` lists
  variables its runs must not see; no default runtime sets one.
- `--add-dir` gives the run every data root's repo that is not inside its working folder.
- A Codex run of a role that does not write starts in its task store, not in its checkout:
  `-C <store>`, with every other data root's folder as `--add-dir`. Codex's sandbox always lets a
  run write its working folder, so this keeps the checkout and the other repos read-only while
  the run's `ops` commands still write the task store. The prompt names the checkout and tells
  the run to read it by path and to run `git -C <checkout>`. If the run has no task store, it
  gets `--sandbox read-only` in its checkout instead.
- The working folder is `--cwd`, then the agent's `cwd` in the config, then the top of the task's
  repo.
- When the working folder is a data root's checkout (the git checkout that holds a `.agent-ops/`
  folder opsd knows), the branch checked out there carries the task store. The run's prompt names
  the store branch (`sync.branch`, else the learned one) and tells the run never to run
  `git checkout` or `git switch` there, and to make code branches in a worktree inside the
  checkout, such as `git worktree add out/wt-<ID> -b <branch> <base>`. A custom prompt (a
  `--prompt-file`, a helper's instructions, a chat turn) gets the same rule appended under
  `Rule for this folder:`, so no launch path skips it. A Claude run there also gets
  `Bash(git checkout*)` and `Bash(git switch*)` denied; Codex has no deny list and relies on the
  prompt. A run in a linked worktree is in no data root's checkout and gets neither. Linked
  worktrees inside a checkout are never changes of it: they do not hold back a writing run, and
  opsd never commits them with what a run left.

### Processes

Every process starts with no console window. opsd stops only processes it started, and never
with a tree kill by bare PID: Windows matches a tree by parent PID alone, which can reach a process
whose parent PID was reused.

- A run opsd started on Linux or macOS leads its own process group; opsd stops the group. The
  child is not reaped yet, so its PID and group cannot have been reused.
- On Windows, and for a run adopted from an earlier opsd, opsd takes a fresh snapshot, adds the
  run's processes to its ledger, and kills the root and every confirmed descendant, each checked
  at the moment of the kill (see the process ledger). A run opsd started on Windows is also
  stopped through Node's own handle to it.
- On macOS, an adopted run is not stopped: creation times there are whole seconds, too coarse to
  check the PID at the moment of a kill. opsd warns and marks the run ended.

opsd records each run's process creation time before it saves the run. A run adopted from an
earlier opsd is watched only while its PID still has that creation time, so a later process that
reuses the PID is never taken for the run. A run with no creation time on record is marked lost and
never stopped. When the creation time of a live PID cannot be read at adoption (on Windows,
PowerShell can miss its timeout on a loaded machine), opsd keeps the run adopted, warns, and reads
it again in the background, up to five times 10 s apart; the run is marked lost as soon as a read
shows another process. Stopping opsd cancels a pending read and the wait between reads, so they
never hold opsd past the wait of `opsd stop`; the next opsd checks the run again. A kill still
checks the creation time at the moment of the kill.

The desktop app can host opsd: it starts it with its own executable in Node mode
(`ELECTRON_RUN_AS_NODE`), and agent runs do not inherit that flag.

#### Process ledger

Each run keeps a ledger of every process it started, in `procs/<run>.json` in the state folder:
PID, parent PID, name, command line, creation time, and when opsd first and last saw it. A process
is named by its PID and its exact creation time together.

| Platform | Snapshots                                                                               | Ledger                                                                                                        |
| -------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Windows  | one PowerShell helper answers every snapshot and kill (`Get-CimInstance Win32_Process`) | yes; creation times to the millisecond                                                                        |
| Linux    | read from `/proc`                                                                       | yes; creation times in clock ticks                                                                            |
| macOS    | `ps`                                                                                    | no: `ps` reports whole seconds, too coarse to tell a reused PID apart; runs are stopped by process group only |

- Every `proc_seconds` (default 5), and right after a launch, opsd takes one snapshot and adds the
  run's new descendants. The helper itself is never recorded.
- The root joins only with the exact creation time in the run record. Without one, the ledger
  stays empty: a later process that reused the root's PID is never taken for the run.
- A process joins when its parent PID names a process in the ledger:
  - while that parent runs, or if the process started before the last snapshot that saw the
    parent alive (on Linux, at least 1 s before, since creation times come from a boot time in
    whole seconds);
  - as **unsure** if it started after that snapshot but before the parent was seen gone, and no
    process holding the parent's PID now started before it. The parent's PID could have been
    reused in between, so unsure processes, and their children, are listed but never killed
    automatically.
- On Linux a process in the run's process group joins by the same rules, so an orphan that was
  reparented after its parent exited is kept.
- When a run ends, however it ends, opsd takes a last snapshot and kills every confirmed ledger
  process still alive, one by one rather than as a tree, and checks again, up to three rounds.
  Each kill checks the creation time at the moment of the kill: on Windows through the open
  process handle, which keeps the PID from being reused between the check and the kill; on Linux
  from `/proc` right before the signal. A PID that runs another process is left alone. What
  survives shows as `procs_left` on the run, in `ops runs` and in the desktop.
- When opsd starts, it sweeps the ledgers of runs that ended in the last 7 days for survivors.
- `ops procs RUN` lists the ledger with each process alive, killed or gone, and marks unsure ones
  with `?`. `--kill` stops what an ended run left; `--kill --pid N` stops one process, unsure
  ones included, after you checked it. The desktop **Runs** view has the same list, **Kill
  leftovers** and a **kill** link per process.

What can still escape or remains:

- A process whose parent started and exited between two snapshots, so opsd never saw the parent.
- On Linux, a process that was reparented after its parent exited and also left the run's process
  group (`setsid`).
- On Linux, the PID could be reused between the `/proc` check and the signal only if the kernel
  wrapped through the whole PID range in those microseconds.

Windows job objects would close the first gap on Windows; add them if it shows up in practice.

## Limits

opsd starts a run only when every limit has room. A refused `ops launch` names the limit, and
wake and schedules wait for room.

| Limit            | Setting                                      | Counts                                                    | Default                                                        |
| ---------------- | -------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------- |
| PC               | `max_runs`, `min_free_gb`                    | live runs on this PC; free memory                         | number of CPU cores; 4 GB                                      |
| Provider         | `runtimes.<name>.max_live`                   | live runs of that provider on this PC                     | none                                                           |
| Usage allowance  | `usage_pause_at`, `runtimes.<name>.pause_at` | the provider's plan windows, as its runs report them      | pause at 90% of a window until it resets                       |
| Role per project | `roles.<role>.per_project`                   | live runs of the role on one project, over every provider | 1 for roles that write; 3 for `qa`, `reviewer`, `orchestrator` |
| Role total       | `roles.<role>.max_live`                      | live runs of the role on every project                    | none; 1 for `orchestrator`                                     |
| Checkout         | none                                         | live runs of roles that write in one folder               | 1                                                              |

- A run's project is its task's `project`, else its root's name. `claude:engineer` and
  `codex:engineer` count as one role. One task never has two live runs.
- **One writing run per checkout.** A run of a role that writes never starts in a checkout where
  another run of a role that writes is live or planned, whatever project either task names. A
  run's folder is the launch's `cwd`, else `opsd.agents.<id>.cwd`, else the top of the git repo
  of its task's root, so tasks in one root share a checkout. Its checkout is the top of that
  folder's git work tree, so two runs in different subfolders of one checkout count as one; each
  linked `git worktree` is its own checkout, and a folder outside git is its own. Two engineers on
  different projects run at once only when their projects live in different roots or their
  agents have their own checkout. Helpers work under their parent and are not counted, and
  neither are question runs or chat turns: a chat turn has `Edit` and `Write` denied, so it
  neither holds a checkout nor waits for one, whatever its role.
- **A writing run starts on a clean checkout.** While a git checkout has changed tracked files or
  untracked files outside task stores (`.agent-ops/` and every root's folder), no run of a role
  that writes starts there; `ops waits` says `checkout has uncommitted changes in <top>` and
  names a file. Ignored files do not count. A checkout that is itself a task store is never
  checked. When such a checkout holds a writing run and no live or ending run works in it, opsd
  (`opsd:checkout`) posts once in `#general`, mentioning the human, so it lands in their Inbox:
  which run waits, the checkout and its first changed file. It posts again for that checkout only
  after it was clean once. A checkout with a live run gets no post: the changes may be that run's
  work, which its wrap-up commits.
- **What a run leaves goes to a branch.** Codex runs in a sandbox that keeps `.git` read-only, so
  they cannot commit. When a top-level run of a role that writes ends and its checkout has
  changes outside task stores, opsd commits them with the normal git on a new branch
  `<runtime>/<task>-<run>` (lowercase; `<runtime>/run-<run>` without a task), from the commit the
  run started on (`base` on the run record). The message is the task's title, then
  `Changes left by run <id> (<agent>).` The commit is built in a temporary index, so neither the
  index nor the checked-out branch takes it. opsd then restores those files to that commit, and
  deletes files the run added. A
  file that changed again after the commit, or whose staged version is in neither the commit nor
  HEAD, stays as it is and is named in the run's `run-end` event, so nothing is discarded that the
  commit does not hold.
  - The `run-end` event names the branch and the commit.
  - If the run ended without `ops review`, opsd sends the task for review with the commit and
    branch: to the reviewer the task's delegation expects, else the first active `qa` agent of
    another provider, else the human. If the run already asked for review, opsd comments to its
    reviewer where the files went.
  - opsd commits only once nothing of the run still writes: it first reaps the processes the run
    left behind and waits up to 30 seconds for the run's helpers to end, including helpers that
    ended first and are still reaping their own processes. Until then the run counts as live, so
    it holds its checkout and its task. If processes of the run or of a helper survive the
    reaping, or a helper is still running, opsd commits nothing and says so in the `run-end`
    event.
  - The run's record keeps how far this wrap-up got (`wrap_up`: `pending`, `committed`,
    `recorded`, `settled`, `done`). If opsd stops or restarts before it is `done`, the next opsd
    resumes it from that step: it reaps again, commits, records the `run-end` event and sends
    the task for review, each once. A branch the earlier opsd already created for the run is
    reused, and only the restore of the checkout is finished.
  - If HEAD is no longer the commit the run started on (the run, or a person, moved it) and
    changes are left, opsd commits nothing and says so in the `run-end` event; the checkout stays
    as it is for a person, and no writing run starts there until it is clean.
  - Runs that commit themselves (Claude) leave nothing, so nothing happens. Merging the branch
    stays with the orchestrator or a person after approval.
  - Any other top-level run, such as a `qa`, `reviewer` or chat run, gets the same wrap-up when
    its checkout had no changes outside task stores at its start, so what it leaves never holds
    writing runs. A run that started on a checkout with changes has no `base`, and opsd commits
    nothing after it: those changes were there before it.
- A finding filed with `ops finding --task ID` and a task created with `--parent ID` take the
  project of that task unless `--project` names another.
- A task that names no project counts under its root's default project: `project` in the root's
  `config.yml`, else the root's `name`. `project_aliases` there maps old project names to the
  current one, so tasks filed under two names count as one project.
- `roles.<role>.writes: false` marks a role that only reads code and posts to Agent Ops.
- **Bottleneck first.** Wake plans across every waking agent, in this order: review requests (one
  run per request; the run gives a verdict and holds no claim); tasks that resume after an answer
  or a change request; new claims; last, runs that only read new inbox items, since they name no
  work. Within each: priority, then the project with the fewest live runs, then age. Each planned
  run counts against the limits before the next is planned. When a project has `review_backlog`
  (default 3) tasks waiting for review, opsd starts no new work there for roles that write, and
  its reviewers may run up to `roles.<role>.burst` (default twice `per_project`), so reviews catch
  up before more work piles on.
- **Helper runs.** A run that works on a task and still holds its claim starts helpers with
  `ops spawn [AGENT] -m PROMPT` (`POST /api/runs` with `parent`). A helper works on the parent's
  task, always in the parent's folder, under its claim. It may comment on tasks but never change
  their state (`OPS_PARENT_RUN` marks it), counts against the PC, provider and usage limits but
  not the role limits, may not start helpers of its own, and stops when the parent ends (reason
  `parent-ended`), also when opsd restarts after the parent ended. `roles.<role>.max_children`
  (default 2) caps helpers per run. Sub-agents a runtime starts inside its own process (Claude
  Code's Agent tool) are not opsd runs: they share the run's provider allowance and are not
  counted.
- **Providers.** A task owned by `*:<role>`, or by nobody, goes to the first waking agent of the
  role whose provider has room, in the order of `roles.<role>.providers` (default: the order of
  `runtimes`). With `overflow: false` it waits for the first provider. A task owned by one agent
  (`claude:engineer`) waits for that agent.
- Providers do not limit how many sessions run at once; their plans limit usage in windows. Claude
  Pro and Max have a five-hour and a weekly window shared by Claude, Claude Code and the IDEs;
  Codex Pro has a weekly window, Plus and Business a five-hour and a weekly one. opsd reads them
  from run output: Claude Code's `rate_limit_event` in `stream-json`, and the `rate_limits` of
  the Codex session file named after the thread id in `codex exec --json`
  (`$CODEX_HOME/sessions`, default `~/.codex/sessions`). It keeps them in `usage.json` in the
  state folder. A provider that refused work for its limit is paused until the reset it reported.
  Runs whose output has no such event still count: a usage-limit error in the output (Claude
  Code's "usage limit reached", Codex's "hit your usage limit", an API `rate_limit_error`) pauses
  the provider until the reset it names, or for `usage_cooldown_minutes` (default 30).
- The part of a window over `usage_pause_at` stays for your own Claude and Codex sessions; runs
  already going finish.
- Limits are per PC. A provider account spans PCs: with opsd on two PCs, set `usage_pause_at` or
  `max_live` on each to share it.
- `ops usage` and `GET /api/usage` show each provider's windows, live runs and whether it is
  paused. `ops waits` and `GET /api/waits` list the wake plan: what waking agents could start, in
  order, with why each waits (the first limit in the way for each agent, or a review backlog).
  `ops runs` ends with what waits, the desktop **Board** shows the reason on each waiting task,
  and the **Agents** view shows the plan and each provider's usage.

## Config

The `opsd` section of the user config (`%APPDATA%\agent-ops\config.yml`,
`~/.config/agent-ops/config.yml` or `OPS_CONFIG`):

```yaml
me: human:dawid
opsd:
  port: 4747 # 0 picks a free port
  tick_seconds: 15
  proc_seconds: 5 # how often the processes of live runs are looked at
  max_runs: 24 # default: the number of CPU cores
  min_free_gb: 4 # no new run below this much free memory
  usage_pause_at: 0.9 # no new runs on a provider past 90% of a usage window
  usage_cooldown_minutes: 30 # pause after a usage-limit error that names no reset
  budget_minutes: 180
  wake_cooldown_minutes: 10
  sync: true # commit, pull and push each root when its sync policy says so
  seeded: 1 # the defaults were written once; from then on runtimes lists every provider
  runtimes:
    claude: { command: claude, model: opus }
    codex: { command: codex, pause_at: 0.95 }
    hermes: { command: hermes, args: [run, --json, '-'], unset_env: [GH_TOKEN], paused: true } # paused: no new runs
  # Without `seeded`, entries merge into the default claude and codex key by key, as before.
  review_backlog: 3 # reviews waiting in a project that hold new work there
  roles:
    engineer: { per_project: 1, providers: [claude, codex], overflow: true, max_children: 2 }
    qa: { per_project: 3, burst: 6 } # qa and reviewer only read
  agents:
    codex:engineer: { wake: true, budget: 2h, model: gpt-5-codex }
    claude:qa: { wake: true, cwd: 'C:\dev\agent-ops' }
    claude:pm: {} # an agent with no settings of its own
  schedules:
    - name: digest
      at: '09:00' # daily, local time; or every: 30m
      agent: claude:pm
      prompt: Write the daily digest of open tasks and post it to the ops channel.
      paused: false # true keeps it without starting runs
```

- **Wake:** each tick, opsd carries out the wake plan (see "Limits"): one run per review request,
  per task in the waking agents' queues that has no live run, and per agent with new inbox items
  and no run, as long as the limits have room. An inbox item counts as seen once an inbox run
  reads it, or once a run works on the task it is about.
- **Schedules** start their agent when due and the limits have room. The desktop **Schedules**
  view and `/api/schedules` add, change, pause, run and delete them in the user config.
- **Changes from the app:** `POST /api/settings` and `/api/schedules` edit the user config in
  place (comments kept, written through a temporary file), validate the result before writing, and
  reload it: roots, limits, agents and schedules apply from the next tick; `port` and
  `tick_seconds` at the next start.
- **Sync** runs `ops sync --auto` logic for each root only when a pull or push is due, so commits
  happen at sync times, not every tick.

## Chat

The desktop **Chat** view is one conversation with the PM (`opsd.chat.agent`, default `claude:pm`,
which every new config seeds).

- **Each message is a run.** opsd starts a run of the chat agent with no task, under every limit
  in [Limits](#limits). The `pm` role is read-only (`writes: false`, no `Edit` or
  `Write`, claims only `question` tasks unless its role file sets `can_claim`), so a chat turn
  never waits for an engineer run or a merge on the same checkout. One agent runs once at a time:
  a message sent while another run of the chat agent is live waits, and the view says why. Messages sent while a turn runs wait for the next turn,
  which reads them all.
- **One session.** The first turn starts a Claude session with `--session-id`; later turns pass
  `--resume`, so the context carries from message to message. The first turn's prompt holds the
  role file and the chat rules; later turns get a short reminder. A turn that fails without a
  reply drops the session, and the next message starts a new one. The chat runs on Claude only:
  only Claude runs get a session to resume and a streamed reply, so `opsd.chat.agent` refuses an
  agent on any other runtime.
- **What it may do.** A chat turn's tools are the role file's `tools`, else `Read`, `Grep`,
  `Glob`, `git log` and `git show`, plus `ops`. `Edit`, `Write`, `ops verdict` and `ops decide`
  are always denied. Its prompt allows creating tasks, comments, assigning, retyping, priority,
  parking, channel posts, findings and answering agents' asks; never a verdict, a vote decision,
  an answer for the human, or claiming and working a task.
- **Streaming.** opsd reads a live turn's log (`--include-partial-messages`) every 300 ms and
  sends the reply so far as a `chat` event. When the turn ends, the reply is saved with what the
  agent did in Agent Ops during the turn (task events, new tasks and channel posts by the agent
  between the run's start and end), shown as links.
- **Mentions.** With `opsd.chat.mentions` (default `true`), each tick reads channel posts that
  mention the chat agent (`@claude:pm` or `@*:pm`) and adds them to the chat.
  The turn answers in the channel with `ops channel post` and sums up in the chat. Those mentions
  never wake an inbox run of the chat agent. The first time, opsd reads mentions of the last 24
  hours.
- **Stop.** **Stop** ends the live turn and drops the messages no turn read yet. With no turn live,
  it ends the chat agent's other live run that queued messages wait for.
- **New conversation** starts a new session with no messages, refused while a turn runs. The old
  conversation stays in `chat-<id>.json` in the state folder.

The conversation lives in `chat.json` in the state folder, on this machine only.

```yaml
opsd:
  chat:
    agent: claude:pm # one Claude agent, no wildcard
    mentions: true # channel posts that mention it join the chat
    budget: 20m # one turn; default: the agent's budget
```

## Merging approved work

With `opsd.merge.<root name>` set, opsd merges a task's work into a base branch once a review
approves it. The setting lives in the user config, not in the task store's `config.yml`, so the
commands opsd runs are set on each machine and never arrive through a sync.

```yaml
opsd:
  merge:
    v2: # the root's name
      base: v2 # the branch approved work goes into
      checkout: 'C:\dev\agent-ops' # where the base is built; default: the root's git top
      checks: # run on the rebased work, in opsd's own worktree
        - npm install --no-audit --no-fund
        - npm run typecheck
        - npm run lint
        - npm test
        - npm run leaks
      build: [npm run build] # run in `checkout` after the base moved
      timeout_minutes: 30 # per command
```

- **What it merges.** A task whose last verdict approves it, when the review that verdict answers
  names `<commit> on branch <name>` (the form `ops review` asks for, and the one opsd's own
  leftover reviews use) or `branch <name>`, which merges the branch tip. The commit wins over the
  tip: opsd merges what the reviewer approved. Only verdicts after opsd first saw the root's
  setting count (`merge.json` in the state folder), so turning it on merges no old work.
- **How.** One merge at a time. opsd waits until no writing run is live in `checkout`, and from
  then until the build is over, no writing run starts there (`ops waits` says
  `opsd merges <task> into <base>`). In its worktree (`<state>/merge/<root>`, kept between merges
  so installed packages stay), opsd rebases the commit onto the base and runs `checks`. Then it
  fast-forwards the base: with `git merge --ff-only` where the base is checked out, so the work
  tree follows and local changes are never overwritten, else by moving the ref only if it did
  not move. When the base moved meanwhile (a task store sync, another merge), opsd rebases again,
  and runs the checks again only if code changed. Then it runs `build` in `checkout` and adds a
  `merge` event (`opsd:merge`) with the new commit to the task.
- **When it fails.** A conflict, a failed or timed-out check, or a branch that changes task store
  files sends the task back to its owner: a `changes` verdict from `opsd:merge` with the end of
  the output, and the whole output in `<state>/merge/logs/`. Lines of the output that look like a
  secret (the patterns `ops` refuses in events), and private key blocks whole, are taken out
  before either is written. A failed build comes after the base
  moved: opsd records the merge and sends the task back to fix it in a new commit. A merge opsd
  cannot do (the branch or commit is missing, the base kept moving, local changes in the way) gets
  a comment to the root's human, and opsd does not try that task again until it changes.
- opsd never forces a ref, never resets a work tree it did not create, and never restarts
  itself: after a merge that changes opsd's own code, restarting opsd stays a person's or the
  orchestrator's step. A merge stopped with opsd before the base moved starts again from the
  beginning in the next one. One stopped during the build, after the base moved, is recorded with
  the build left pending (`merge-builds.json` in the state folder): the next opsd runs the build
  first, before any other merge, and comments on the task when it passes or sends the task back
  when it fails.
- On Windows, each check and build command runs in a job object of its own, through a small
  PowerShell launcher that starts `cmd.exe` suspended, puts it in the job and only then lets it
  run. The job allows no breakaway, so everything the command starts is in it, detached
  processes and their children too. A stop or timeout ends the launcher, and with it the job and
  every process in it. When the command exits, the launcher ends what it left running. This needs
  no process list and no kill by PID, which a sandbox may refuse. Where no job can be made, the
  command does not run and fails with `could not run in a job object`.
- Off Windows, opsd follows each command's processes in a ledger, like a run's (on Linux, which
  gives exact creation times). A stop or timeout kills every process of the command, each checked
  by PID and creation time, and the command's process group gets SIGTERM. After a command exits,
  opsd kills what it left running. On every platform, a check or build must not start a process
  meant to outlive it.
- Off Windows, what survives every kill is kept in `merge-procs.json` in the state folder. Until
  it is gone, this opsd and the next start no merge and no build, and warn each tick, so a
  leftover build never races a new one in the same checkout. opsd stops reading a command's
  output 5 s after the command exits, so a leftover holding the output never holds a merge or a
  shutdown.

## Pushing task branches

Work that is not merged yet lives on task branches, and without a push only on this machine. At
each sync that pushes a root (the scheduled push under the root's sync policy, and the sync after
every run), opsd pushes the task branches of the root's repo to its remote. It is on for every
root; to turn it off for one, set it to `false` in the user config:

```yaml
opsd:
  push_branches:
    v2: false # the root's name
```

- **Which branches.** Branches named after a runtime opsd knows, such as `claude/*` and
  `codex/*`, which includes the branches opsd commits run leftovers to (`<runtime>/<task>-<run>`).
  A branch is pushed when it has commits whose changes neither the bases nor its remote branch
  have: the branch checked out in the root's checkout (`v2` for the engine), the root's
  `opsd.merge` base, and the remote's default branch. A branch merged by hand with a rebase or a
  cherry-pick has nothing new and is not pushed. A merge commit counts as new when its result
  differs from every parent somewhere, such as a conflict resolution; a clean merge of a base
  does not.
- **Where.** The remote of the checked-out branch, else `origin`, else the only remote. The push
  uses the machine's git sign-in, the one opsd runs with.
- **Never forced.** A push is always a fast-forward of the remote branch. When the remote branch
  has commits this clone lacks, or the remote refuses the push, opsd leaves it and warns once in
  the opsd log until either side changes. A base branch is never pushed here; it moves with the
  normal sync or a person's push.
- **No secrets.** Before a push, opsd reads every line the new commits add, including lines a
  merge commit adds in its conflict resolutions or edits. When one looks like a
  secret (the patterns `ops` refuses in events) or a commit adds a key file (`.pem`, `.key`,
  `id_rsa`, ...), the branch stays here and the log names the file, never the line. Messages from
  a failed push leave out URLs and sign-ins.
- **After a merge.** When opsd merges an approved branch (see the preceding section), it remembers
  the approved commit, so that branch is not pushed again unless new commits land on it. Once the
  remote's base has the merged commit, opsd deletes the remote branch, only while the remote
  branch holds nothing beyond the approved commit, and with a lease on the tip it checked, so a
  push that lands in between keeps it. The local branch stays. The engine's task store sync does
  not push code commits on the base, so the delete waits for the push of the base.
- An unreachable remote ends the round with a warning; the next sync tries again. What opsd
  decided and what it has to delete are kept in `branches.json` in the state folder.

## Machines

With `machine` set in the user config, opsd writes `machines/<machine>.json` in each data root it
syncs (not in mirror roots): last seen, live runs and their agents, opsd version and build. It
rewrites the file only when something changed or the record is 20 minutes old, so syncs carry it
without a commit every tick. A machine counts as alive when it wrote in the last 70 minutes.
`GET /api/machines` lists every machine seen; **Agents** shows them.

## Notifications

Set `opsd.notify.webhook` (a Discord or Slack incoming webhook, https; http only to this machine)
in **Settings** or the user config, never in a data root. Each tick, opsd posts new inbox items for
`me` (asks, reviews, findings to triage, decisions, mentions, messages) and runs that failed (non-zero exit, lost,
over budget) as one message, at most 6 messages per 10 minutes; items already waiting when
notifications start are not sent. `opsd.notify.kinds` limits what is sent. The URL is a secret:
settings never return it, and warnings say only the HTTP status.

## API

opsd listens on `127.0.0.1` only. Every request needs the token from `opsd.json` as
`Authorization: Bearer <token>` (only `GET /api/events` also takes `?token=`, because
`EventSource` cannot send headers) and a `127.0.0.1` or
`localhost` Host header, so a web page in a browser cannot call it.

### Run tokens

The token in `opsd.json` is the full token: the desktop app and `ops` outside a run use it, and it
acts as whoever `as` names. Each supervised run also gets its own random token in `OPS_RUN_TOKEN`;
opsd keeps only its SHA-256 in the run record, so an opsd that adopts the run still knows it. Inside
a run, `ops` sends that token only to the opsd on `OPS_RUN_STATE_DIR`; an opsd on another state
folder, such as one started by a test, gets the full token from its own `opsd.json`.

A run token:

- Acts as the run's agent and run id; opsd ignores `as`. A helper run's token cannot change task
  state, like `ops` inside the helper.
- Stops working when the run ends.
- Cannot change settings, roles, schedules or root mirroring; test notifications; answer or give
  verdicts; pause, resume or stop opsd; or launch runs for another agent.
- Can stop only its own run or a direct helper, and can clean up only a direct helper's processes.
  It cannot stop or clean up another run.

These checks prevent accidental or ordinary API use from crossing run boundaries. A run still
runs as your operating-system user, so it can read files that user can read. To request a daemon
restart or another human-only action, use `ops ask`.

| Method and path                                              | Effect                                                                                                                                                                                                   |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`                                            | pid, version, `build` (when the code opsd runs was built), live run count, `me`                                                                                                                          |
| `GET /api/doctor`                                            | the `ops doctor` checks, run by opsd on the env and config it runs with                                                                                                                                  |
| `POST /api/roots/:name/mirror`                               | turn mirroring into the Master Repo on or off for a project root: `on` (true or false)                                                                                                                   |
| `GET /api/events`                                            | Server-Sent Events: `hello`, `run`, `tasks`, `changed` (tasks, channels or votes), `sync`, `warn`, `chat` (`run` and `streaming`, the live reply so far; or `changed`)                                   |
| `GET /api/chat`, `POST /api/chat`                            | the chat: `messages`, the `live` turn, `streaming`, `busy` (another run of the agent), `waiting` (why queued messages wait); `POST` sends `text` and starts a turn when the limits have room             |
| `POST /api/chat/stop\|reset`                                 | stop the live turn (or the run queued messages wait for); start a new conversation                                                                                                                       |
| `GET /api/runs`, `GET /api/runs/:id`                         | run records (`?live` for live ones)                                                                                                                                                                      |
| `GET /api/runs/:id/log?tail=N`                               | the end of a run's log, as text                                                                                                                                                                          |
| `GET /api/usage`                                             | each provider's usage windows, live runs and pause reason                                                                                                                                                |
| `GET /api/waits`                                             | `providers` (as `/api/usage`) and `waits`: tasks waking agents could start, in wake order, with the reason                                                                                               |
| `POST /api/runs`                                             | launch: `agent`, `task`, `prompt`, `cwd`, `budget`, `tokens`; `parent` for a helper of a live run                                                                                                        |
| `POST /api/runs/:id/kill`                                    | stop a run                                                                                                                                                                                               |
| `GET /api/runs/:id/procs`, `POST /api/runs/:id/procs`        | the run's process ledger with `alive` for each; `POST` kills what an ended run left, or `pid` alone                                                                                                      |
| `GET /api/tasks`, `GET /api/tasks/:id`                       | tasks (`?all` includes closed and archived), one task with its events                                                                                                                                    |
| `POST /api/tasks`                                            | create a task: `title`, `body`, `to`, `type`, `priority`, `project`                                                                                                                                      |
| `POST /api/tasks/:id/:action`                                | `comment`, `answer`, `start`, `block`, `review`, `unblock`, `done`, `release`, `reopen`, `park`, `assign`, `priority`, `retype` (`type`, optional `to` assigns in the same write), `verdict`, `delegate` |
| `GET /api/agents`, `GET /api/inbox`                          | agents (role files and the opsd config) with `wake` and a live run, the actor's inbox                                                                                                                    |
| `GET /api/decisions`, `POST /api/decisions/:id/vote\|decide` | votes                                                                                                                                                                                                    |
| `GET /api/channels`, `GET\|POST /api/channels/:name`         | channels with descriptions; read and post                                                                                                                                                                |
| `POST /api/channels`                                         | create a channel: `name`, `description`                                                                                                                                                                  |
| `POST /api/notify/test`                                      | send a sample message to the notification webhook; the answer never holds the URL                                                                                                                        |
| `GET /api/machines`                                          | every machine seen in the roots, newest record each, with `alive`                                                                                                                                        |
| `GET /api/report?days=N`                                     | progress per project and usage per provider and agent over the last N days (1 to 366), decisions and channel posts                                                                                       |
| `GET /api/activity?q=Q&before=C&limit=N`                     | one page of task events (plus task creation), archived tasks included, and channel posts, newest first: `items`, `next` (pass as `before`), `total`, `actors`, `projects`; `limit` 1 to 500, default 100 |
| `GET /api/kb?q=WORDS&topic=T`                                | learn notes across roots; every word must match (as `ops kb`); no words lists them all                                                                                                                   |
| `GET /api/kb/:topic/:slug?root=R`                            | one learn note; `root` when the ref exists in several roots                                                                                                                                              |
| `GET /api/standup?hours=N`                                   | per agent: done, sent for review, working on, blocked; runs, tokens, minutes; `#standup` posts                                                                                                           |
| `GET /api/schedules`, `POST /api/schedules`                  | schedules with `last_run` and `next_run`; add one, or change the one named `previous`                                                                                                                    |
| `POST /api/schedules/:name/run\|delete`                      | start a schedule's run now (under the limits), or remove it                                                                                                                                              |
| `GET /api/settings`, `POST /api/settings`                    | effective settings and the keys the file sets; `patch` changes safe keys only (`null` restores a default)                                                                                                |
| `POST /api/shutdown`                                         | stop opsd (`killRuns: true` to stop runs too; `ifIdle: true` stops only with no run live, else 409)                                                                                                      |

Writes act as `as` in the body or query, or as the user config's `me`; opsd ignores its own
`OPS_AGENT`. Errors return `{ "error": "..." }` with 400 (bad input), 401, 403, 404 or 409
(refused).
