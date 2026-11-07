# Changelog

Agent Ops keeps tasks, events and decisions as files in git. Releases start at 0.2.0. Notes for
people who use the app are in [UPDATES.md](UPDATES.md); this file lists every change.

Unreleased changes are in [`changelog.d/`](changelog.d/README.md). `scripts/fold-changelog.mjs` folds
them in at release time (see [RELEASING.md](RELEASING.md)).

## 0.2.0-beta.3 (2026-11-07)

### Added

- `ops doctor` (and **Settings** health checks) warns when a user-level copy of the `agent-ops` skill in `~/.claude/skills`, `~/.codex/skills` or `~/.agents/skills` differs from the skill this install ships, names the sections it lacks, and says which file to copy over it. Claude Code and Codex load those copies in place of the repo copy, so a stale one hides new guidance from agent runs.
- The desktop app ships the `agent-ops` skill in `resources/app/skills/agent-ops/` for that comparison.
- `GET /api/timeline` returns a project's or root's history as a replay timeline: lanes per agent, work spans, review rounds, waits on answers, runs with tokens, decisions, learn notes and closed tasks, with totals for stat cards and a time map that plays idle stretches fast. The data comes from the task events already in the store.

### Changed

- `ops sync` starts fewer git processes: a sync with nothing to send runs 4 instead of 10, and
  mirroring a project root into the Master Repo reads each side's pushed files once instead of once
  per task. Syncs are faster on Windows, where each git process costs tens of milliseconds.
- The desktop app renders event text as Markdown in the Inbox (messages, questions, review requests, triage questions), Activity, Decisions, the task panel checkpoint, the Agents waiting list, schedule prompts and repeating task descriptions. Long text in lists shows its first lines and expands on a click.
- The Inbox shows the whole message, question or mention, not only its first line: inbox items carry the full text as `detail`.
- Every `ops` command that takes a message reads it from stdin with a lone `-` as well as with `--body-file -`, and keeps its newlines; `--body-file` turns Windows line ends into `\n`.
- `ops show` prints a multi-line event body with its lines kept, indented under the event, instead of joining them into one line.
- The `agent-ops` skill and `AGENTS.md` ask agents to write event text as a summary line and short bullets for done, open and next, with one example per finishing command.
- When Claude Code or Codex is signed out, opsd stops at the first run that cannot sign in. It starts no more runs of that provider, chat turns included, and tells you once: in your inbox, as a desktop notification and as a banner in the app, with how to sign in (`claude`, then `/login`; `codex login`) and which reviews wait. It checks the sign-in every 3 minutes with `claude auth status` or `codex login status`, which call no model, and starts runs again once you signed in; **Resume** in the banner or `ops daemon resume` starts them at once. opsd also checks each sign-in when it starts.
- While a provider is signed out, work for a role group such as `*:engineer` goes to the next provider. Work sent back to an agent of the signed-out provider by name goes to the same role on another provider after 15 minutes (`opsd.signed_out_handoff_minutes`). The chat answers with how to sign in, and your messages wait until you do. `ops usage`, `ops waits` and the app show "signed out" as the reason work waits.

### Fixed

- opsd no longer reads a stray word after "branch" in a review as the branch to merge ("this branch does not touch it"). A `branch <name>` counts only when the repo has that branch; when the approved review names no source, opsd merges the branch an earlier review of the task names.
- opsd no longer restarts a run every tick when a runtime's runs end with an error at once. After a run ends with an error within 10 seconds, opsd waits 1, 5 and then 15 minutes before the next run of that runtime. After the fourth failure in a row, it posts one message to you in `#general` and tries once an hour until a run works. To try again sooner, pause and resume the runtime in **Settings**, run `ops daemon resume`, restart opsd, or send a chat message. The wait shows in `ops waits` and the usage report.

## 0.2.0-beta.2 (2026-11-05)

### Added

- The task panel shows the triage actions. An open idea gets **Make task**, **Bug** and **Park**, with an owner and a priority. An open finding gets the same actions as **Findings** and the **Inbox**, so accepting it in the panel clears it there too.
- `ops retype --priority P` and the `priority` field of `POST /api/tasks/:ref/retype` set the priority in the same write as the new type.
- Repeating tasks: a template in the task store (`repeats/<name>.md`) that creates a task at a local date and time, then daily, weekly, on chosen weekdays (such as Mon and Thu), monthly or yearly, with an optional end date or count; or when a task, or all subtasks of a parent, close. opsd creates the tasks each tick. Slots missed while the PC was off or opsd was paused fire once, and a repeat waits while the last task it created is still open. Manage them with `ops repeat` (add, edit, list, show, pause, resume, delete, run, tick), `/api/repeats` and the desktop **Repeating** view. Set `opsd.repeats: false` on all but one PC that shares a task store. Repeats mirror into the Master Repo both ways, and `ROOT/NAME` picks one when two roots use the same name; `ops repeat list` and the desktop show those repeats as `ROOT/NAME`.
- The task panel has **Back** and **Forward**. After you follow a task link inside an open task or a message, **Back** in the panel header returns to the task you came from. Alt+Left, Alt+Right and the mouse back and forward buttons do the same. Closing the panel clears the history.

### Changed

- opsd gives ownerless work an owner each tick: an accepted finding, a task whose owner is no configured agent, or a claim of a removed agent once its lease runs out, goes to a role group picked from its type and labels (`bug`, `feature` and `task` to `*:engineer`, `test` and `qa` to `*:qa`, `review` to `*:reviewer`, `question` to `*:pm`), recorded as an `assign` from `opsd:router` with the reason. opsd routes only to a group with a waking agent it would start on the task: one of the role's providers (`opsd.roles.<role>.providers`, `overflow`) whose role file allows the task's type and that is not of the provider of the reviewer a delegation expects. Accepting a finding in the app now starts a run within one tick without a manual assign.
- `ops new` and `ops assign` refuse a role group that no waking agent of the role's providers answers to, and list the role groups, configured agents and person that take work instead. `--force` still passes it.
- The app shows **Waiting for your triage** for an open finding and **Parked idea** for an idea instead of an empty owner.
- `ops waits` lists ownerless work opsd cannot route, with the reason.

## 0.2.0-beta.1 (2026-11-05)

### Added

- Desktop **Activity** view: every task event, task creation and channel post across roots, newest first by day, filterable by who, project and kind. opsd serves it at `GET /api/activity`.
- The `agent-ops` skill for v2 (`skills/agent-ops/SKILL.md`), with copies for Claude Code
  (`.claude/skills`) and Codex (`.agents/skills`) that a test keeps identical.
- `ops archive [--days N]` moves done and parked tasks to `archive/tasks/`. `list --all`, `show`
  and dependency checks still find them, `reopen` moves a task back, and archived ids are never
  reused.
- Desktop board swimlanes (by agent, project or priority), one filter bar for Board and Tasks (project, owner, role, provider, priority, type, label, mine), saved views in the sidebar, and each agent's backlog in **Agents**.
- Channels as files: `ops channel post|read|list`. `@id` mentions land in that inbox.
- Votes as files: `ops propose`, `ops vote`, `ops tally`, `ops decisions` and `ops decide`. Ties
  and missing quorum go to the human; listed voters see open votes in their inbox.
- Across machines, the claim pushed first wins. `ops sync` renames unpushed events to sort after
  the ones it pulled, so every clone folds them in push order whatever the clocks say. Claims carry
  a token, and each clone remembers its own: a run that lost a race (even one with the same agent
  id on another machine) cannot start, renew or release the winner's claim. `ops sync` and
  `ops show` report lost claims; opsd stops a live run whose claim lost (reason `lost-claim`).
- Under the `coordinated` sync policy, `claim`, `handoff`, `delegate`, `verdict` and `ask` sync at
  once, and `ops claim` reports a lost race right away. A push rejected by a newer remote is retried
  after pulling again.
- New events of a task always get an id above its newest event, even when the clock runs behind.
- `ops delegate ID TO` hands a task over with a time budget (`--budget 2h`), a token budget
  (`--tokens 400k`), a due time (`--due`) and an expected reviewer (`--review`). The limits show
  in `ops show`; a later `ops review` without `--to` goes to the expected reviewer.
- Desktop: the task panel shows the conversation oldest first, links each answer to its question,
  shows a sent message at once and counts new agent messages while you read further up. Answer and
  Comment say what each does, and the button Ctrl+Enter sends is highlighted with a hint.
- Desktop: **Notify** lists every agent opsd can run, from role files, the opsd config, each
  runtime with the usual roles, and agents seen lately (`GET /api/directory`).
- Desktop: **Settings > Providers** adds and removes custom runtimes after a system dialog shows
  the exact command, and pauses any provider (`opsd.runtimes.<name>.paused`).
- Desktop: **Create role** and **Edit** write role files with instructions, `kb` topics, files to
  read first, a writing style and limits (`GET /api/roles/<id>`, `POST /api/roles`); opsd puts
  the reading list and style in each run's prompt.
- Desktop: the **Agents** view explains what starts runs and lists agents ready without a role
  file, each with a **Wake** switch.
- Desktop redesign: providers and roles are color-coded everywhere (a drawn mark per provider, an
  icon per role), priorities show as Urgent, Medium, Standard and Low, and a new look throughout.
- Task panel: a status menu with the moves the protocol allows, a priority menu, the owner as a
  tag, agent tags with a filterable dropdown, `@` mention autocomplete, and delegation with a
  calendar and an optional time.
- Board: drag cards between columns to change status; Working, Blocked and Review ask for what
  they need.
- New **Standups**, **Schedules** and **Settings** views, **New channel** in Channels, an Inbox
  grouped by what you need to do, and a Runs view that explains runs and starts one.
- opsd: `/api/settings`, `/api/schedules` (`paused` is new), `/api/standup`, `POST
  /api/channels`, and the task actions `start`, `block` and `review` in the API.
- `npm run smoke:desktop` renders every desktop view offscreen and fails on page errors, failed opsd calls or refused calls; the release workflow runs it.
- The desktop app (`npm run desktop`): inbox with answer and review actions, board, task list,
  task panel with comment, delegate, run, release, close, park and priority, agents with live
  runs, run logs followed live, votes and channels. It starts `opsd` when none runs, updates on
  `opsd` events and shows desktop notifications for items addressed to you.
- `ops doctor` checks the user config, data roots, the opsd config, each runtime on PATH and signed in, opsd and its build, and free memory and disk; exit 1 when a check fails. opsd serves the same checks at `GET /api/doctor`, and the desktop **Settings** view shows them.
- `ops finding` files a bug, risk or idea as a `finding` task linked from the current task.
- `ops learn TOPIC TITLE` writes a learn note to `kb/<topic>/`; `ops kb [words]` searches the
  notes and `ops kb --read TOPIC/SLUG` prints one.
- Desktop **Findings** view to triage what agents file with `ops finding`, and a **Knowledge** view for learn notes. `ops retype ID TYPE` changes a task's type (human or orchestrator); opsd serves `GET /api/kb` and the `retype` task action.
- First-start setup: the desktop app asks for your id and data roots when the user config has no
  `me`, writes the config, and starts `opsd`. `ops init --user` (or `ops setup`) does the same
  from a terminal. An existing config only gains a missing `me`.
- Desktop: a search bar (Ctrl+F) that finds tasks by id, title, description and thread text, plus learn notes, channel posts and votes, with filters such as `agent:codex`, `status:blocked`, `is:open` and `in:notes`. `opsd` serves it as `GET /api/search`.
- Helper runs: `ops spawn [AGENT] -m PROMPT` inside a supervised run starts a helper under the
  run's claim. Helpers count against the PC, provider and usage limits, not the role limits, cap at
  `roles.<role>.max_children` (default 2) per run, and stop when the parent ends.
- Agent Ops Master Repo: `ops master PATH` names one data repo for every project, and `ops mirror on` copies a project root to `<master>/mirrors/<name>/`. Sync keeps both in step (task events, `task.md`, archive moves, channels, learn notes), so a claim made in either place holds in both. **Settings** shows the Master Repo and a mirror toggle per root; opsd starts no run on a project it knows only from the Master Repo unless the agent has a folder to work in.
- Webhook notifications: opsd posts new inbox items for you and failed runs to a Discord or Slack webhook (set in **Settings**, kept only in the user config and never shown again), at most 6 messages per 10 minutes, with a test button.
- Desktop: a tray icon that shows whether opsd runs, is paused or is stopped, and starts, stops, pauses, resumes or restarts it without opening the window. **Settings > Background service (opsd)** has the same controls, a choice to start opsd when the app opens or when you sign in to Windows (tray only, no window), and a switch for notifications when you're needed.
- `ops daemon pause`, `resume` and `restart`. A pause (`opsd.paused`) starts no new runs or schedules until resumed, also across restarts; live runs finish.
- `opsd`, the per-machine supervisor (`ops daemon start|stop|status|run`). It launches Claude Code,
  Codex and other runtimes per role with the role's tool profile, claims the task first, renews
  the claim while the run lives, ends runs over their time or token budget, records `run-start`
  and `run-end` events, and frees the task when a run ends without finishing.
- `ops launch`, `ops runs`, `ops logs` and `ops kill` for supervised runs.
- Schedules, wake on new work, and policy-driven sync in opsd.
- A local API on `127.0.0.1` with a token and Server-Sent Events for the desktop app.
- Desktop command palette (Ctrl+K or Cmd+K) to find tasks, switch views, create a task and move the open task, plus single-key shortcuts outside text fields (`n`, `/`, `g` then a letter, `?`).
- Machine presence: with `machine` set, opsd writes `machines/<machine>.json` in each root it syncs (last seen, live runs, build), and **Agents** shows which machines are alive. opsd serves `GET /api/machines`.
- Each run keeps a ledger of every process it started. When a run ends, opsd kills the ones still
  alive, including children whose parent already exited, and sweeps leftovers of earlier runs at
  startup. Processes that may belong to a reused PID are marked unsure and only killed by hand.
  `ops procs RUN [--kill [--pid N]]`, `GET|POST /api/runs/:id/procs`, and a processes list with
  **Kill leftovers** in the desktop **Runs** view.
- Desktop **Reports** view and `ops report [--days N] [--post CHANNEL]`: tasks per project, runs, minutes and tokens per provider and agent, decisions and channel posts over a window. opsd serves `GET /api/report`.
- Role templates for 13 roles and the owner (`packages/core/templates`), ported from v1;
  `ops init --with-agents` copies them into a new root.
- New roots get a `.gitattributes` that keeps data files LF on every machine.
- `opsd` commits and pushes the task's data root when a run ends, so runs in a sandbox that cannot
  write `.git` (Codex) still sync.
- Wake works bottleneck first: one review run per review request (it gives a verdict and holds no
  claim) ahead of new work, then priority, then the project with the fewest live runs. A project
  with `review_backlog` reviews waiting starts no new work for roles that write, and reviewers may
  burst there.
- Role wildcard owners: a task owned by `*:engineer` goes to the first provider in
  `roles.engineer.providers` with room, or waits for the first one with `overflow: false`.
- Run limits per PC, provider, role and project replace one live run per agent id. Engineers on
  different projects run at once, one per project by default; read-only roles such as QA get 3.
  opsd reads each provider's usage windows from run output and pauses new runs on a provider at
  90% of a window until it resets (`usage_pause_at`). `max_runs` defaults to the number of CPU
  cores, with a free-memory floor. Wake starts one run per task across projects. `ops usage` and
  `GET /api/usage` show the windows.
- Claim records name the run that claimed, so two live runs of one agent id on one PC cannot act on
  each other's tasks.
- `ops hooks install` adds Claude Code `SessionEnd` and `PreCompact` hooks that run
  `ops sync --session-end`, so a session always pushes its task changes.
- `ops sync --auto` and `--session-end` exit 0 with a note in a folder without a data root.
- A usage-limit error in a run's output (Claude Code, Codex, or an API `rate_limit_error`) pauses
  new runs on that provider until the reset it names, or for `usage_cooldown_minutes` (default 30).
- `ops` CLI on a file store: tasks in `tasks/<id>/task.md`, one event file per change, state
  folded from events, and a local index cache. Commands: `init`, `roots`, `whoami`, `agents`,
  `new`, `list`, `show`, `next`, `claim`, `start`, `progress`, `checkpoint`, `release`, `handoff`,
  `assign`, `review`, `verdict`, `done`, `ask`, `block`, `answer`, `unblock`, `comment`,
  `priority`, `park`, `reopen`, `inbox`, `sync` and `leaks`.
- Claims with leases, dependencies that unblock on their own, and a review rule that wants a
  reviewer from another provider than the author.
- `ops sync` commits only the data root, refuses leaked secrets, pulls with rebase, and holds back
  pushes that would carry code commits. Policies: `manual`, `checkpoint` (default) and
  `coordinated`.
- Pre-commit leak check for this repo (`scripts/check-leaks.mjs`).
- `ops waits` and `GET /api/waits` list what waking agents could start and why each waits. The
  desktop **Agents** view shows each provider's usage and pause, the waiting work, several live runs
  per agent, and agents named only in the opsd config.
- Windows installer (`AgentOps-Setup.exe`) with automatic updates from GitHub Releases. It installs the desktop app, opsd and the `ops` command together, and they update together. The installer can add `ops` to your user PATH (checked by default); agent runs that opsd starts always find it. An update downloads in the background and installs once no agent run is live and the window is closed, or at once from **Settings > Updates** or the tray.
- Agent runs no longer inherit `ELECTRON_RUN_AS_NODE` from an opsd that runs inside the desktop app, so an Electron app they start runs normally.
- Ask one agent a question from the app with the **Question** type in **New task**. Pick the agent, write the question and reference tasks and projects with the `#` picker. It creates a task of type `question` owned by that agent; only that agent takes it, and opsd wakes it (when wake is on) with the question and the referenced tasks in its prompt. The agent answers with `ops done ID "answer"`, and the answer lands in your inbox, labeled **Answer**. Question runs do not count against project run limits. From the CLI: `ops new "question" --type question --to codex:qa`.
- opsd merges approved work: with `opsd.merge.<root>` set (base branch, checks, build), a task
  whose review named `<commit> on branch <name>` is rebased onto the base once approved, checked,
  fast-forwarded into the base and built, and the task gets a `merge` event with the new commit.
  A conflict or a failed check sends the task back to its owner with the output, secret-looking
  lines taken out. A build stopped with opsd runs again in the next opsd, after every process the
  stopped build started has ended. On Windows, checks and builds run in a job object, so a stop
  ends everything they started. See "Merging approved work" in `docs/supervisor.md`.
- When a checkout with uncommitted changes holds a run of a role that writes and no run works in
  that checkout, opsd tells you once in your Inbox, through a `#general` post from
  `opsd:checkout`: which agent and task wait, the checkout and its first changed file. It posts
  again for that checkout only after it was clean once.
- The docs have a website at [dawid-ai.github.io/agent-ops](https://dawid-ai.github.io/agent-ops/),
  built from the README and `docs/` on each change to `main`. `npm run docs` builds it locally into
  `dist/docs` and fails on a broken link or anchor.
- Providers and agents come seeded and are fully editable. `ops setup`, the app's first start and opsd's first start write the default providers (`claude`, `codex`) into the user config, and the default agents on a new machine; after that the config is the only source. An existing config gets the providers written on the next opsd start, with a note in the opsd log.
- **Settings > Providers** edits every provider the same way: the program, arguments and removed environment (confirmed in a system dialog), the model, most live runs, pause at and paused. It shows whether each program is on PATH and which agents use it. **Remove** works for every provider, **Reset to default** restores a seeded one, and **Add back** returns a removed default.
- The **Agents** view adds agents (provider, role, model, Wake), edits each card's model, removes agents the config lists, and opens or creates their role file. An agent whose provider does not exist is refused, and runs of a removed provider say why they do not start.
- A run's model comes from the agent's setting, its role file or its provider, passed as `--model` to Claude and `-m` to Codex.
- Images in tasks, comments and channel posts. In **New task**, the task composer, the inbox reply box and channels, paste an image (Ctrl+V), drop one, or pick one with the image button. The image is stored in the data root as `attachments/<id>.<ext>` and synced like events, and the text gets a Markdown image link. Threads show attached images inline; a click opens them full size. PNG, JPEG, WebP and GIF up to 5 MB; the app downscales big screenshots before upload.
- `ops attach FILE [--task ID]` stores an image and prints the Markdown link. `ops show` lists the images a task's text refers to, with their local file paths (`attachments` in `--json`).
- The app shows only attached images from the data roots, never images from other URLs. The leak check skips image files.
- The desktop app has a **Chat** view: one conversation with the orchestrator. Each message runs as one orchestrator run under the usual limits, the runs share one Claude session so the context carries over, replies stream in, and the tasks it created, assigned or commented on show as links. **Stop** ends the reply; **New conversation** starts over.
- Channel posts that mention `@*:orchestrator` or `@claude:orchestrator` join the chat, and the orchestrator answers in the channel. `@*:<role>` now counts as a mention everywhere, so it reaches the inbox of every agent of that role.
- The `orchestrator` role defaults to `writes: false` and `max_live: 1`. The orchestrator role template gains read-only `tools` and a chat section.
- opsd pushes task branches at each sync: branches named after a runtime (`claude/*`, `codex/*`,
  run leftover branches) with commits the bases lack go to the repo's remote, never forced and
  never a base branch, and held back when a new commit adds a secret-looking line or a key file.
  After opsd merges an approved branch, it deletes the remote branch once the remote's base has
  the merge. `opsd.push_branches.<root>: false` turns it off for a root. See "Pushing task
  branches" in `docs/supervisor.md`.
- The README opens with a short promo animation and screenshots of the desktop app, made from a
scratch demo workspace by `scripts/readme-media.mjs` (screenshots) and `scripts/promo-video.mjs`
(video and GIF). The docs site now copies the images a page shows instead of linking to them on
GitHub.
- opsd starts a run of a role that writes only on a clean checkout: while a checkout has changes
  outside task stores, `ops waits` says `checkout has uncommitted changes`.
- When a run ends and left changes in its checkout, as sandboxed Codex runs do, opsd commits them
  on a new branch `<runtime>/<task>-<run>` from the commit the run started on, restores the
  checkout, names the branch and commit on the task, and sends the task for review if the run did
  not. It commits only after the run's leftover processes are reaped and its helpers have ended,
  and commits nothing when HEAD moved during the run. Task store files never go into that commit.
- A restart of opsd no longer skips the end of a run: what is left of its wrap-up (the commit,
  the `run-end` event, the review or release) runs when the next opsd starts.
- Typing `#` in New task, the task composer, channel posts and the other message boxes opens a task picker: search by id, number or title words, open tasks first, then projects. A pick inserts a plain reference agents read as-is: `AO-0047`, `root/AO-0047` when two roots share the id, or `project:v2`.
- Task references in the app are chips with the task's status color; Markdown bodies, comments and channel posts also show the title, and every chip shows status and title on hover. `ops show` output stays plain text.
- A microphone button in every composer turns speech into text at the cursor: click to start and stop, or hold to talk. Turn it on in **Settings > Voice input** with whisper.cpp on your PC, where audio never leaves it, or with OpenAI, which you confirm first and which uses the key in `OPENAI_API_KEY`. It is off by default.
- The desktop app refuses every browser permission except the microphone, which only its own page gets, and only while voice input is on.

### Changed

- CI runs only on release tags (`v*`) and on manual dispatch, not on every push or pull
  request.
- The desktop **Activity** view shows the full history, archived tasks included, instead of the last 400 events. It loads 100 at a time with **Show 100 older**, and its search box filters by words and by `agent:`, `task:`, `project:`, `kind:`, `type:`, `channel:` and `in:`. opsd keeps an index in each root's `.ops/activity.json` and rebuilds it from the task and channel files when it is missing. `GET /api/activity` now returns a page (`items`, `next`, `total`, `actors`, `projects`) and takes `q` and `before`.
- `ops new` and `POST /tasks` by an agent file a finding (a proposal that waits for triage) unless `--parent` names an open task a human or the orchestrator created or accepted, or a subtask of one. Humans and the orchestrator create tasks as before; `ops new` prints a note when it files a proposal.
- The desktop chat talks to `claude:pm` by default, the PM every new config seeds, instead of
`claude:orchestrator`, which a new install doesn't have. The `pm` role is read-only like `qa` and
`reviewer`: its runs get no `Edit` or `Write` and claim only `question` tasks unless the role file
sets `can_claim`, so a chat turn never waits for an engineer run or a merge.
- Codex runs no longer drop `GITHUB_TOKEN` and `GH_TOKEN` by default. Every run inherits opsd's
  environment and acts as your accounts; task events record which agent did what, and Codex's
  sandbox still blocks network access and `.git` writes. To hide variables from a runtime, set
  `opsd.runtimes.<name>.unset_env` in your config.
- Run prompts and the agent-ops skill tell agents to decide technical choices themselves and, when they cannot commit, push or open a PR, to finish with `ops review` naming the commit or files instead of asking a person for access.
- **Chat with the PM** replaces **Ask an agent** in the Inbox and sits at the top of the sidebar: one click opens Chat, one conversation with the project's PM, with no agent to pick. The first-run screen points to it. The **Question** type in **New task** and `ops new --type question` stay, for agents asking agents.
- An answered question keeps its reply box in the task panel: **Reply** reopens it with your text, and the agent's next run sees the earlier answers and your reply in its prompt.
- The README quick start now runs end to end: it starts from a git repository, uses agent ids that
  have role files (`ops init --with-agents`), works in PowerShell as well as bash (`--as` instead
  of `export`), and ends with a first agent run through opsd.
- Each supervised run now calls opsd with its own token (`OPS_RUN_TOKEN`). opsd acts as the run's
  agent for it, ignores `as`, and refuses human-only actions.

### Fixed

- The desktop app can call `/api/runs/:id/procs`, `/api/usage` and `/api/waits`; its API
  allowlist refused them, so the **Runs** processes list showed an error.
- A Settings limit on `claude` or `codex` (such as **Most live runs**) replaced the built-in
  runtime entry: runs lost their command, and Codex runs lost `unset_env` for `GITHUB_TOKEN` and
  `GH_TOKEN`. Config entries now merge into the built-in ones key by key.
- The inbox listed each question twice, as a question and as a message, and the message stayed
  after the answer. The question item now carries the question text and who asked.
- opsd pushes `tasks` and `changed` right after a write through its API instead of at the next
  3-second poll.
- `npm run smoke:desktop` waits for opsd before it renders views, so a slow opsd start no longer
  fails the check.
- Desktop fonts that Vite inlined as `data:` URLs were blocked by the page CSP; fonts now ship as files.
- `ops hooks install` sets a 60 s timeout on the sync hooks, so Claude Code no longer cancels the
  session-end push after 1.5 s. Running it again upgrades hooks written without a timeout.
- `ops next`, `opsd` wake and `ops waits` no longer hand out tasks of type `idea`; they can still be claimed by id. The desktop board hides ideas behind an **Ideas** toggle, and the task list filters by type.
- `ops inbox` and the desktop inbox write task and decision refs as `root/id` when several
  roots are visible, and each item carries its `root`, so equal ids in two roots stay apart and
  the app answers and reviews the right task.
- `ops list` and `ops next --all` print `root/id` when several data roots are visible, so equal
  ids in two roots no longer look the same.
- Desktop notifications for decisions and channel mentions open the Decisions and Channels
  views instead of a task panel that cannot resolve them.
- The desktop app restarts an idle `opsd` that runs an older build than the one installed (it
  showed "no route GET /api/waits"), and shows a banner while runs keep a busy one going.
  `GET /api/health` returns the `build` stamp.
- On Windows, an opsd that restarts on a loaded machine no longer marks a live run lost when PowerShell does not answer the creation-time check in time. It keeps the run adopted, reads the creation time again in the background, and ends the run as lost only once that read shows another process; stopping opsd cancels a pending read. Stopping opsd no longer starts PowerShell to release its lock, so a stop is not held past the wait of `opsd stop`. Starting opsd waits up to 75 s for it to answer while its process runs (it was 15 s), so a start whose creation-time reads wait on PowerShell no longer fails while opsd keeps starting in the background.
- opsd starts one run of a role that writes per checkout, whatever project its task names, so two
  engineer runs no longer edit, test and commit in the same working tree at once. Runs started
  in different subfolders of one checkout count as runs in that checkout.
- `ops finding --task ID` and `ops new --parent ID` give the new task the project of that task
  unless `--project` names another.
- Supervised Claude runs now also refuse `kill <pid>`, `Stop-Process` and `taskkill` through
  `pwsh`, `powershell` or `cmd`, a force push with the flag after the refspec or a `+` refspec,
  and `rm -fr /` and other flag orders.
- On Windows, `unset_env` removes a variable whatever the case of its name, so `Github_Token`
  no longer survives `unset_env: [GITHUB_TOKEN]`.
- `SECURITY.md` says the tool lists prevent mistakes rather than stop a determined run, and names
  the credential stores a run can still use.
- `ops` no longer crashes with an `EPIPE` stack trace when its output is piped into a reader that closes early, such as `ops show ID | head -4`; the command finishes with its own exit code.
- Codex runs of a qa, reviewer or orchestrator agent can no longer change files in their checkout. They start in their task store, the only folder they can write, so `ops` commands such as `ops verdict` still work; the prompt tells them where the checkout is.
- Agent pickers that set an owner, reviewer, delegate, question target or comment recipient offer only agents a write accepts: role files and agents in Settings, plus people and groups. A runtime with a usual role, an agent seen lately or a typed unknown id shows greyed under **Not configured**; a click on it opens an **Add agent** dialog filled in for that id, above the form you were in. That form stays as you left it, and after the add its picker holds the new agent. Run and schedule pickers still offer every runtime and role, since opsd starts those runs without a role file. A store with no role file and no agent in Settings accepts every id, so its pickers grey nothing. `GET /api/directory` marks each entry `configured`.
- `ops block --on` and `ops new --blocked-by` store a dependency in another root as `root/id`, and dependency checks resolve each id against the waiting task's root, so a task no longer unblocks when a task with the same id closes in another root.
- The desktop app refuses calls whose path URL parsing would change, such as `/api/kb/../usage`,
  so the page can no longer reach routes outside the allowed list through `..`, `%2e`, backslash,
  tab or newline forms.
- The dialog that confirms adding a provider quotes each argument that has spaces, so `["a b"]`
  and `["a", "b"]` no longer look the same.
- The app no longer changes a task's status without a click on a confirming button. **Done**, **Reopen**, **Unblock** and **Release** from the status menu, a board drop or the palette used to apply at once; they now open a dialog like the other moves. Typing the open task's id in the palette finds the task instead of offering moves on it, so Enter no longer reopens or closes it.
- `ops next`, opsd wake and `ops waits` skip findings until a person accepts them in triage, and `ops claim` and `ops start` refuse an untriaged finding without `--force`, also when it is already claimed.
- opsd no longer plans or retries runs for an agent whose role file says `status: paused` or `status: proposed`; `ops waits` names the role status as the reason instead of saying the run starts at the next tick.
- `ops handoff`, `ops assign`, `ops review` and `ops delegate` print a `note:` when the target role is paused or proposed, or when every role a `*:role` or `runtime:*` group matches is inactive. The command still goes through.
- The Inbox lists findings waiting for triage with the Findings view's Accept, Bug, Idea and Park actions; acting in either place clears both. A finding with an open question to you shows the question, and Accept sends your answer in the same write (`ops retype --answer`).
- A review item in the Inbox and in `ops inbox` shows the latest review request: who asked, when, its text, and the PR, commit and branch it names, instead of "waits for your review". The request no longer shows a second time as a message.
- An ask in the Inbox says it stays until answered, and the disabled **Answer** button says to write the answer first.
- Webhook notifications and the desktop notifications include findings to triage (`triage` in `opsd.notify.kinds`).
- Windows: killing a run, or stopping opsd with `killRuns`, now ends the run's launcher and its
  command even when opsd cannot list processes (as in a sandbox). opsd kills the launcher by the
  PID and creation time the run recorded; if it cannot, it warns `stop it yourself` instead of
  leaving the launcher and command running unnoticed.
- Report refused Linux process kills (`EPERM`) as errors instead of treating the process as already gone.
- The app links every task id in rendered text (`AO-0047`, `root/AO-0047`) to its task panel, and `AO-0014#<event id>` opens the panel scrolled to that event.
- `ops ask`, `ops assign` and `ops comment --to human:*` print a `note:` when the message names no task or is shorter than a sentence; the message is still written.
- `ops show ID --ids` prints each event's id, for `ID#<event id>` references.
- The `agent-ops` skill, `AGENTS.md`, the protocol and the supervised run prompt tell agents that every message to a person names the task (and the event for a comment), says what it is about, and states the decision or action needed.
- **New task** can create ideas: pick the **Idea** type. An idea has no owner or due date and stays out of every agent's queue, as with `ops new --type idea`. The board remembers its **Ideas** toggle, and creating an idea turns it on so the new idea shows right away.
- A task that names no project reads as its root's default project (`project` in the root's
  `config.yml`, else the root's `name`) in every view: CLI, app and opsd's run limits. Before, opsd
  counted it under the root's name while the app showed it with no project.
- `project_aliases` in the root's `config.yml` maps old project names to the current one, such as
  `v2: agent-ops`. Tasks filed under an old name read as the new one, `ops list --project` finds
  them by either name, and new tasks given an old name store the new one. `task.md` files are not
  rewritten.
- This repo's tasks read as one project, `agent-ops`; the 97 tasks filed as `v2` map to it.
- opsd no longer starts a task or review run of an agent while an inbox run of that agent is live or starting, so one event, such as a verdict, no longer has two runs do the same work. The task run starts after the inbox run ends. Scheduled runs with their own prompt do not hold the agent's tasks back.
- opsd no longer wakes an agent for a task whose type its role file's `can_claim` does not allow, for example a `task` owned by `*:orchestrator` when the role takes only `question`. `ops waits` says `<agent>: role takes only <types>` instead of saying the run starts at the next tick.
- The inbox no longer lists events the reader wrote, and a comment addressed to its own author is written without an addressee, so your own comment no longer shows up as a new message. The **Notify an agent** picker leaves you out, and an `@` mention of yourself notifies nobody.
- Agent pickers and menus close on a pick and on a click elsewhere, also inside a dialog or the task panel. The due date picker closes on a date pick, or on the time when you add one. Escape closes only the open list, and Escape in **New task** with typed input asks before it discards it.
- A qa, reviewer or orchestrator agent with no `can_claim` in its role file no longer claims unowned tasks, bugs or features (only questions), and its Claude runs get no Edit, Write or NotebookEdit tools. A task assigned to such an agent by name still starts, whatever its type.
- Chat turns no longer hold writing runs on the same checkout, and opsd commits what any run leaves on a checkout that was clean at its start to a task branch.
- `ops review` on a task, bug or feature refuses a request that names neither `<commit> on branch <name>` nor a PR while the checkout has uncommitted changes, unless opsd commits the leftovers.
- opsd no longer holds writer runs for reviews that wait for a person or for an agent opsd does not run; only reviews by agents in its config count toward `review_backlog`.
- Keep supervised Claude runs from editing role files, and refuse API role creation that would shadow the same role in another data root.
- Honor `--root` when `ops next`, `ops next --all`, and `ops list` enumerate tasks.
- Bound supervised-run API tokens to their own run and direct helpers, and refused privileged
  schedule, notification, mirroring, daemon and cross-run process actions from agent runs.
- `ops sync`, opsd and the Master Repo mirror commit task store changes only while the store
  branch is checked out: `sync.branch` in `config.yml`, else the branch the clone learned on its
  first sync, which must be the one local branch holding the newest store commit (ties go to the
  one with an upstream). With a code branch checked out in the data root's checkout, or a detached
  HEAD, they commit nothing and say why; the files stay on disk for the next sync on the store
  branch. Before, store commits landed on the code branch and switching back removed their events
  from disk.
- Runs that opsd starts in a data root's checkout no longer switch its branch. The run prompt
  names the store branch and asks for code branches in a worktree (`out/wt-<ID>`), and Claude runs
  there get `git checkout` and `git switch` denied. Runs with a custom prompt, helper runs and chat
  turns get the same rule appended to their prompt. Before, a run could check out its code branch
  in the store's checkout, and the task store stayed uncommitted until someone switched back.
- opsd no longer counts a linked worktree inside a checkout as an uncommitted change, and never
  commits one with what a run left.
- While a code branch holds the store's checkout, the opsd log shows the "not synced" note once
  instead of on every tick, and again when the note changes.
- Prevented Unix run cleanup from missing surviving process-group members or signaling a reused
  leader PID during its forced-kill follow-up.
- Every agent card in **Agents** has the **Wake** switch and a budget field, so an agent whose wake is on can be turned off where it is listed. Turning wake off removes `opsd.agents.<id>.wake` from the config; the agent stays until you remove it.
- Report and retry refused Windows process kills instead of treating the process as already gone.
- On Windows, `ops` commands no longer fail with `EPERM` or `EBUSY` on a task lock file while
  another process deletes it or a scanner holds it open, as happens when several agents work the
  queue on one machine. They retry until the lock timeout; an `EPERM` that never clears still
  shows as an `EPERM` error, not as a lock timeout.
- Screenshot mode (`AGENT_OPS_SCREENSHOTS`) renders in software, so it works on a machine without a
GPU such as a Linux CI runner, and a failed capture ends the app with exit code 1 instead of
leaving it open.
- `ops review` no longer counts a task store as uncommitted code work when the checkout path reaches
it in its Windows short form (such as `C:\Users\RUNNER~1`): it compares real paths and leaves out
every `.agent-ops/` folder by name, as opsd does.
