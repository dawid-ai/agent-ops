# Updates

What changed in each release, for people who use the app. Every change, including the small
ones, is in [CHANGELOG.md](CHANGELOG.md).

## v0.2.0-beta.5 (2026-11-07)

- **Signed-out agents stop cleanly.** When Claude Code or Codex is signed out, opsd stops at the
  first run that cannot sign in and tells you once, with how to sign in. Work for a role such as
  `*:engineer` moves to the other provider meanwhile, and runs start again once you sign in.
- **No more restart loops.** A runtime whose runs fail at once waits 1, 5 and then 15 minutes
  before the next try, instead of starting a run every tick.
- **Messages read as written.** The Inbox, Activity, Decisions and the task panel show event text
  as Markdown, with its line breaks, and the Inbox shows the whole message.
- **Faster sync.** `ops sync` starts fewer git processes, which matters most on Windows.
- **Fixes.** opsd merges the branch a review names, and no longer mistakes a stray word after
  "branch" for one. `ops doctor` warns when a user-level copy of the `agent-ops` skill is out of
  date.

## v0.2.0-beta.2 (2026-11-05)

- **Repeating tasks.** Set a task to come back daily, weekly, on chosen weekdays, monthly or
  yearly, or whenever another task or a set of subtasks closes. Manage them in the new
  **Repeating** view or with `ops repeat`. A repeat waits while its last task is still open, and
  a slot missed while the PC was off fires once.
- **Work without an owner finds one.** A finding you accept, or a task whose owner isn't a
  configured agent, goes to the right role (engineer, QA, reviewer or PM) within a tick, so it
  starts without you assigning it. `ops new` and `ops assign` refuse an owner no agent answers to.
- **Triage from the task panel.** An open idea or finding shows **Make task**, **Bug** and
  **Park** right in the panel, with an owner and a priority.
- **Back and Forward in the task panel.** Follow a task link, then go back with the panel's
  **Back**, Alt+Left or the mouse back button.

## v0.2.0-beta.1 (2026-11-05)

The first installable Agent Ops.

- **One installer for everything.** `AgentOps-Setup.exe` installs the desktop app, opsd (the
  background service that starts and watches agent runs) and the `ops` command. They update
  together: a new version downloads in the background and installs once no agent run is live and
  the window is closed. **Settings > Updates** and the tray install it sooner.
- **`ops` in your terminal.** The installer can add `ops` to your PATH, for PowerShell, cmd and Git
  Bash. Agent runs always find it, whatever you choose.
- **A tray icon for opsd.** Green running, amber paused, grey stopped, with a blue dot when
  something needs you. Right-click to start, stop, pause, resume or restart opsd without opening
  the window, and choose whether opsd starts with the app or when you sign in to Windows.
- **Search everything.** Ctrl+F finds tasks by id, title, description or anything said in their
  thread, plus learn notes, channel posts and votes. Narrow it with `agent:codex`,
  `status:blocked`, `is:open` or `in:notes`.
- **Everything from the build so far:** the board, inbox, task threads, agents and roles,
  providers, runs, schedules, standups, reports, channels, votes and the knowledge base.

This is a beta and the installer is not signed yet, so Windows SmartScreen warns on first run:
choose **More info**, then **Run anyway**.
