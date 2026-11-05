# Updates

What changed in each release, for people who use the app. Every change, including the small
ones, is in [CHANGELOG.md](CHANGELOG.md).

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
