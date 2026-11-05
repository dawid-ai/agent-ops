# Desktop app

The desktop app is the human's control room on top of `opsd`: the inbox, the board, task details
with every action, agents and their runs, run logs, votes and channels.

## Install and updates

On Windows, `AgentOps-Setup.exe` from GitHub Releases installs the app for your user (under
`%LOCALAPPDATA%\Programs\Agent Ops` unless you pick another folder). The app carries opsd and the
`ops` command as bundles it runs with its own executable as Node, so no separate Node.js is
needed:

- `resources\app\`: `main.mjs` (the app), `opsd.mjs`, `ops.mjs`, the UI.
- `resources\bin\`: `ops.cmd` for PowerShell and cmd, and `ops` for Git Bash. The installer adds
  this folder to your user PATH when **Add the ops command to my PATH** is checked (the default);
  uninstalling removes it. If you edited PATH at or before that entry since installing, uninstalling
  leaves PATH as it is, so remove the entry yourself. Agent runs always get it first on their PATH
  from opsd.

The app checks GitHub Releases a minute after it starts and every 4 hours, and downloads a new
version in the background. It installs on its own once no agent run is live and no window is open
(the app sits in the tray): it stops opsd, which runs from the files the installer replaces,
installs silently and starts again in the tray. **Settings > Updates**, the banner and the tray's
**Restart to update** install at once; with runs live they ask first: the runs keep going and the
new opsd adopts them, but their `ops` commands fail while the files are replaced. A development
build run from a checkout never updates itself.

## Run from a checkout

From the engine checkout:

```bash
npm install
npm run desktop   # builds the core, opsd and the UI, then opens the app
```

On the first start, when the user config has no `me`, the app asks for your id (default
`human:<OS user name>`) and the data roots to load (default: the root it was started in), then
writes the user config (`%APPDATA%\agent-ops\config.yml`, `~/.config/agent-ops/config.yml` or
`OPS_CONFIG`) and starts `opsd`. An existing config keeps everything, comments and roots
included, and only gains a missing `me`. If an `opsd` that runs no agents is
already up, the app restarts it to load the config; one that runs agents keeps going, and the app
says to restart it. From a terminal, `ops init --user [--me human:NAME] [--root DIR]...` (or `ops setup`) does the
same.

The app starts `opsd` when none runs and connects to the one that does. An `opsd` started before
the engine was rebuilt runs an older build (its `GET /api/health` `build` differs from the one on
disk): the app restarts it at once when no run is live, and otherwise shows a banner and tries
again every 30 s, so no agent is cut off. Closing the window leaves `opsd` and every agent run
going; stop them with `ops daemon stop` (add `--kill-runs` to stop the runs too; an `opsd`
whose runs cannot outlive it refuses a stop without it while runs are live).

## Background service and tray

**Settings > Background service (opsd)** shows whether `opsd` runs, is paused or is stopped, with
its live runs, and has these controls:

- **Start**, **Stop** and **Restart**. Stop and Restart never stop a run, on Windows too: live runs
  keep going and the next `opsd` adopts them. While `opsd` is stopped, the runs' own `ops` calls
  that go through it fail until it is back. An `opsd` that reports runs cannot outlive it
  (`runs_outlive: false` in `GET /api/health`) ends its runs when it stops; with runs live, Stop
  and Restart (here and in the tray) then ask in a system dialog before they end them, and ending
  a run releases its claim. To let runs finish instead, cancel, pause new runs and stop when none
  are live.
- **Pause new runs** and **Resume new runs**. While paused, no wake, schedule, **Run now** or
  `ops launch` starts a run; helper runs of live runs still start, live runs finish, and sync,
  notifications and the API keep working. The pause is `opsd.paused: true` in the user config, so
  it lasts across restarts until you resume. From a terminal: `ops daemon pause` and
  `ops daemon resume`.
- **Start opsd**: **When I open the app** (the default) or **When I sign in to Windows**. Sign-in
  adds the app to your Windows sign-in apps (the per-user Run key, through Electron's login-item
  API) with `--background`: it starts in the tray with no window and starts `opsd`. Windows lists
  it under **Task Manager > Startup apps**, where you can also turn it off. The entry is written
  only when you pick the option, never in screenshot mode. It starts `opsd` in the folder you
  picked it from (`--ops-cwd`). The app reads the entry from the registry by its name,
  `Agent Ops`, so it still finds one made from a moved or replaced checkout: the card then shows
  the command the entry runs, with **Start this app instead** and **Remove the entry**. An entry
  turned off in Task Manager shows as off. Other systems get this later.
- **Notify me when I'm needed**: a Windows notification for each new question, review or vote
  addressed to you; clicking it opens the task. Off is `desktop.notify: false` in the user config.

While the app runs it has a tray icon (the notification area, bottom right of the taskbar). Its
colour is the state: green running, amber paused, grey stopped, with a blue dot while something
waits for you. Left-click opens the window; right-click offers the same controls as the card, the
items that need you, the notification switch, and **Quit Agent Ops**. Closing the window keeps the
tray icon; Quit closes the app, and `opsd` keeps running. One app runs per person: starting it
again shows the open one.

## Views

| View          | What you do there                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Inbox**     | What waits for you, grouped: questions to answer, reviews, decisions, tasks assigned or delegated to you, mentions; **Chat with the PM** opens Chat                                                                      |
| **Board**     | Tasks by status; drag a card to another column to change its status (Working, Blocked and Review ask for what they need); swimlanes by agent, project or priority; ideas stay hidden until you turn on **Ideas**         |
| **Tasks**     | Search and filter by status, project, owner, role, provider, priority, type and label; sort by priority or update; due dates                                                                                             |
| **Findings**  | Bugs, risks and ideas agents filed with `ops finding`: accept as a task or bug with a priority and owner, set aside as an idea, or park                                                                                  |
| **Standups**  | Per agent and person: done, in review, working on, blocked, runs and tokens, from the task history; `#standup` posts                                                                                                     |
| **Activity**  | Every task event and channel post across roots, newest first by day; filter by who, project and kind (work, reviews, talk, runs, findings and notes)                                                                     |
| **Reports**   | A week, 30 or 90 days: tasks opened, closed, parked, open and blocked per project; runs, minutes and tokens per provider and agent; decisions taken; channel posts                                                       |
| Task panel    | Status and priority menus, owner as a tag, the conversation oldest first with each answer linked to its question, comments with `@` mentions and **Notify**, delegate with a due date and time, run an agent             |
| **Agents**    | What starts runs (wake, Run agent, schedules), **Create role**, each provider's usage and pause, work waiting with why, machines, agents by provider with live runs and backlog, agents ready without a role file        |
| **Runs**      | Every run with its log, followed live; readable or **raw**; its processes and **Kill leftovers**; **Start a run**                                                                                                        |
| **Schedules** | Recurring runs (opsd's cron): add, edit, pause, **Run now**, delete; templates for standups, inbox sweeps, nightly QA                                                                                                    |
| **Repeating** | Repeating tasks: a template that creates a task once, daily, weekly, on chosen weekdays, monthly, yearly, or when a task or all its subtasks close; add, edit, pause, **Run now**, delete; state, next slot, last task   |
| **Chat**      | One conversation with the orchestrator: replies stream in, what it changed shows as task links, `@*:orchestrator` posts from channels join it; **Stop**, **New conversation** (see [the supervisor](supervisor.md#chat)) |
| **Channels**  | **New channel**, read and post; `@id` in a message puts it in that inbox                                                                                                                                                 |
| **Decisions** | Tallies and ballots; decide ties and votes without quorum                                                                                                                                                                |
| **Knowledge** | Learn notes from `kb/` by topic; search with the same matching as `ops kb`; links to the task a note came from                                                                                                           |
| **Settings**  | opsd status and restart, health checks (same as `ops doctor`), data roots, the Master Repo and which project roots mirror into it, webhook notifications, run limits, providers, roles, which agents wake on work        |

Agents and people are color-coded everywhere: the tile color and mark show the provider (Claude,
Codex, a person), the corner badge and the role name's color show the role (engineer, QA, PM,
docs). Priorities show as **Urgent**, **Medium**, **Standard** and **Low** for `p0` to `p3`; agents
and the files keep `p0` to `p3`. A due date alone means the end of that day; add a time in the
picker for an exact one.

The status menu and the board offer only moves the protocol has one action for: **To do**
releases, unblocks, reopens or requests changes; **Working** starts work (you take it, or an agent
run starts); **Blocked** asks why and on whom or what; **Review** asks for the reviewer; **Done**
closes; **Parked** asks why. Other moves are dimmed with the reason. Every move, from the status
menu, a board drop or the palette, opens a dialog and changes nothing until you click its button
there, so no stray pick, drop or Enter closes or reopens a task in your name.

**Chat with the PM**, at the top of the sidebar and in the Inbox, opens **Chat**: one
conversation with the project's PM (the orchestrator), with no agent to pick. An answer never
closes it, and it survives a restart of the app. A task of type `question` that an agent answered
keeps its reply box: **Reply** reopens it with your text as the next round, and its owner answers
again.

**Settings** writes the user config with its comments kept, and opsd applies the change at once.
Through opsd's API it changes limits, roles, a provider's `model`, `max_live`, `pause_at` and
`paused`, removes a provider or resets a seeded one to default, adds, edits and removes agents
(`wake`, `budget`, `model`), sync and roots only.

- **Providers.** `ops setup`, the app's first start and opsd's first start write the default
  providers (`claude`, `codex`) into the user config; from then on the config is the only source,
  and every provider is edited the same way. Each row shows whether its program is on opsd's
  PATH, the agents that run on it, and its model, most live runs, pause-at share and pause
  switch. **Add provider** and **Edit** take the name, the program, its arguments and the
  environment variables its runs must not see. Electron's main process, not opsd, writes those,
  after a system dialog shows the exact command line; the page and anyone holding the API token
  cannot change which program a run starts. **Remove** works for every provider and names the
  agents that use it first; their runs then do not start and say why. **Reset to default**
  restores a seeded provider's entry, and **Add back** returns a removed one. A paused provider
  starts no new runs; live runs go on.
- **Agents** (the Agents view). **Add agent** takes a provider from Settings, a role, a model and
  the Wake switch; an agent whose provider does not exist is refused. Each card edits Wake, the
  model and the budget, opens or creates the role file `agents/<provider>-<role>.md`, and removes
  an agent the config lists (its role file stays). A card whose provider was removed says
  **no provider**.
- **Role files.** **Create role** and **Edit** write `agents/<provider>-<role>.md` in a data root:
  name, description, instructions (the body), `kb` topics and `files` to read first, a writing
  `style`, a budget and the task types it takes. opsd repeats the reading list and style in every
  run's prompt. The app never sets `tools`; edits keep other frontmatter. A role file's `model`
  sets the run's model unless the agent's own `model` in Settings overrides it; `mcp` is kept as
  metadata only.
  Agents without a role file still run with the built-in prompt.

**Answer and Comment.** While a task waits on you, **Answer** closes the question and puts the
task back to to do, so the agent goes on; **Comment** adds a note and the task keeps waiting.
Ctrl+Enter sends the highlighted button: **Answer** while the task waits on you, else **Comment**.

The window updates when `opsd` reports a change (Server-Sent Events): at once after a write
through the app, and within 3 seconds after an agent writes from the CLI. A message you send shows
in the open task at once; an item you handle in the inbox leaves with a confirmation that links to
the task. The app shows a desktop notification for each new question, review, decision or mention
addressed to you.

**Saved views.** Board and Tasks share one filter bar. **Save view** names the current filters (and the board's lanes) as a view under **Saved views** in the sidebar. Views are stored in the app on this machine, never in a data root.

**Search.** The box under **New task** (Ctrl+F from anywhere) searches every root: tasks by id (`AO-0047` or `47`), title, description and every comment, answer and verdict in their threads, plus learn notes, channel posts and votes. Every word must match; `"quoted words"` match together. Filters narrow it: `agent:` (an owner, author or anyone who acted on the item; a full id, a runtime such as `codex`, a role such as `qa`, or a name such as `dawid`), `status:`, `project:`, `type:`, `priority:`, `root:`, `is:open` or `is:closed`, and `in:tasks`, `in:notes`, `in:posts` or `in:votes`. Results drop down as you type; arrow keys and Enter open one, and Enter on the query opens **Search** with every result, grouped by kind. The same search is `GET /api/search?q=...`, which answers `{ hits, partial }`. Each request has a fixed work budget (file system calls and bytes read), so a search never blocks `opsd` on a large store; when a request reaches it, `partial` is `true` and the app says it searched part of the store. Each kind in each root gets a share of the budget, and `root:` skips the other roots before any work. Items read once stay cached, and each request picks up each folder where the one before it stopped, so searching again covers more; an item too large for a whole share is skipped.

**Voice input.** Every composer (New task, comments, answers, channel posts, standups) has a
microphone button at its top right. Click it to start and click again to stop, or hold it and
release to stop; the text goes in at the cursor, or replaces the selection. Recordings stop after
five minutes. Turn it on in **Settings > Voice input**; it is off by default and then records
nothing.

- **On this PC (whisper.cpp).** Pick `whisper-cli.exe` from the
  [whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases) and a model file such
  as `ggml-base.bin` from the [model list](https://huggingface.co/ggerganov/whisper.cpp/tree/main).
  Both are picked in a system file dialog; the page cannot name the program. Audio never leaves
  the PC: the main process writes the recording to a temporary folder, runs whisper.cpp on it, and
  deletes the folder.
- **OpenAI.** Sends each recording to OpenAI's transcription API (`gpt-4o-mini-transcribe`, or
  `desktop.voice.cloud_model` in the user config) with the key in `OPENAI_API_KEY` from the app's
  environment. The app never stores the key. Turning it on asks in a system dialog first.

The settings live under `desktop.voice` in the user config: `engine` (`off`, `local` or `cloud`),
`program`, `model`, `language` (`auto` or a code such as `pl`) and `cloud_model`.

**Keyboard.** Ctrl+K (Cmd+K on macOS) opens the command palette: find a task by id or title, go to a view, create a task, or move the open task (start, review, block, done, back to to do) through the same calls as the board. Outside text fields, `n` starts a new task, `/` focuses the view's search, `g` then a letter goes to a view (`g b` board, `g l` tasks, `g i` inbox, `g c` channels, `g k` knowledge), and `?` lists every shortcut.

**Back and Forward in the task panel.** Following a task link inside the open task panel (a thread, a comment, the parent, a blocked-on task, a message) keeps the task you came from. **Back** in the panel header returns to it, and **Forward** goes again after Back. Alt+Left, Alt+Right and the mouse back and forward buttons do the same outside text fields. A link to the task already open adds no step. Closing the panel clears the history, so a task opened from a view with no panel open has no **Back**.

## Security

- The page talks to `opsd` only through Electron's main process, which holds the API token; the
  page never sees it. The main process accepts only `/api/` paths.
- The window runs with context isolation and the renderer sandbox, without Node, under a content
  security policy that allows only the app's own files.
- Task text, comments and messages come from agents, so Markdown is sanitized before it is shown.
- Links open in the browser; the window never navigates away from the app.
- The app refuses every browser permission except the microphone, and grants that only to its own
  page in its own window while voice input is on. No page gets the camera, the screen, location or
  notifications.

## Screenshots for checks

`AGENT_OPS_SCREENSHOTS=<dir>` renders the app offscreen, saves one PNG per view in
`AGENT_OPS_VIEWS` (default every view; `task:<id>` and
`runs:<id>` open one task or run), and quits. It needs no GPU or visible desktop.

## Smoke check

`npm run smoke:desktop` (after `npm run build:desktop`) renders every view offscreen against a
scratch data root and fails when a view logs an error, an opsd call fails, or the allowlist refuses
a call. It stops the scratch opsd it started. The release workflow runs it on Linux under
`xvfb-run` for every `v*` tag.
