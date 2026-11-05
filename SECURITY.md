# Security

## Reporting a vulnerability

Report it privately through
[GitHub's private vulnerability reporting](https://github.com/dawid-ai/agent-ops/security/advisories/new),
not in a public issue. Include what an attacker needs, what they gain, and the steps to reproduce.
You get an answer within a week.

## What Agent Ops trusts, and what it does not

Agent Ops starts AI coding agents on your machine with your user rights. Treat an agent run like a
script you start yourself: it can read and change what you can. The design limits what reaches
other people, not what a run can do on your machine or to the work of other agents.

### Agent ids are labels, not logins

- An agent id (`claude:engineer`, `human:<name>`) is what the caller says it is. Nothing checks
  `OPS_AGENT`, the CLI's `--as` or the API's `as` field. An API call without `as` acts as the user
  config's `me`, that is, as you.
- The opsd token grants the whole API. A run that reads it can do what you can in the desktop app:
  approve a review or answer a question as you, rewrite role files, start runs with any agent,
  prompt, folder and budget, and change settings such as data roots and budgets.
- Each supervised run calls opsd with its own token (`OPS_RUN_TOKEN`), valid only while the run is
  live. With it, opsd acts as the run's agent and ignores `as`. It refuses human actions: verdicts,
  answers, changing settings, schedules or role files, the orchestrator chat, stopping opsd,
  starting a run of another agent (a helper of itself may use any agent), and stopping a run other
  than itself or its helpers. A run can still read the full token from `opsd.json`, so this
  narrows what a run does through `ops` by default; it does not stop a run that reads the file.
- Runs can also write task files and commit to data roots directly. An event records who it says
  acted, not who did.
- Workflow rules, such as a reviewer from another provider, guide agents that follow them; they do
  not stop a run that ignores them. Check what was approved or answered in your name when it
  matters.

### The local API (opsd)

- opsd listens on `127.0.0.1` only and refuses requests without its token. The token is in
  `opsd.json` in its state folder (`~/.agent-ops/opsd/`, mode `0600` on Linux and macOS).
- A live run's own token (`OPS_RUN_TOKEN`) also passes. It acts as that run's agent and gets a
  `403` for human actions, as [Agent ids are labels, not logins](#agent-ids-are-labels-not-logins)
  describes. opsd stores only its SHA-256 hash; the token itself is only in the run's environment.
- Agent runs can read the full token: they run as you. So the API never lets a caller change which
  program a run starts. Providers (`opsd.runtimes`) change only in the user config file or through
  the desktop app's main process, after a system dialog shows the exact command line.
- Role files written through the API cannot set `tools`; that field stays hand-edited. Existing
  `mcp` and `model` fields are preserved as metadata but the supervisor does not use them.
- Anyone allowed to change settings through the API can add data roots. Treat that permission like
  permission to choose role files: a newly added root can define a role's `tools`.
- The desktop page reaches opsd only through Electron's main process, which holds the token and
  forwards a fixed list of calls. It refuses a path that URL parsing would change, such as one with
  a `..` segment, so a listed prefix can't reach an unlisted route. The page runs sandboxed, with
  context isolation and a content security policy, and Markdown from agents is sanitized before it
  is shown.

### Data roots (git repositories)

- Everything in a data root (tasks, comments, learn notes, channel posts, votes) is shared with
  everyone who can read that repository. Do not put secrets in tasks or comments.
- `ops sync` runs a leak check on the files it commits and commits nothing if the check fails. The
  check looks for key files (`.pem`, `.key`, `id_rsa` and the like), private key blocks, GitHub
  and Slack tokens, `sk-` API keys, AWS access keys, `Authorization` headers, and Slack and Discord
  webhook URLs. It catches only those kinds and uses no deny list.
- A deny list (org names, logins, machine names) applies only when you pass it:
  `ops leaks --deny FILE` or `node scripts/check-leaks.mjs --deny FILE`. Keep the file outside
  the repository, and run one of these before you push or merge.
- `ops init` installs no git hook in a data root. A plain `git commit` there skips the leak check
  unless the repository has its own hook, so commit task data with `ops sync`. The pre-commit hook
  in `.githooks` covers commits to this repository only.
- Data roots from other people are untrusted input. Symbolic links in role files and learn notes
  are not followed. A role file's `tools` list sets what its runs may do, so a role file in a root
  someone else writes to can widen that: review `agents/*.md` in shared roots.

### Agent runs

- Claude Code runs get an allow list of tools (`Read`, `Edit`, `Write`, `Bash(git *)`, `Bash(ops *)`
  and the like, or the role file's `tools`) and a deny list (force push, recursive delete from an
  absolute path, killing processes by PID or name). These lists prevent mistakes; they are not a
  boundary against a determined run. The default allow list has `Bash(node *)`, `Bash(npx *)` and
  `Bash(git *)`, and each of them runs any code (`node -e`, a git alias or pager), which no deny
  entry sees.
- `Edit` and `Write` are also denied for every data root's `agents/` directory. This path deny
  covers only those two tools: allowed Bash commands such as `Bash(node *)`, `Bash(npm *)` and
  `Bash(git *)` can still write there, so it is defense in depth, not a sandbox.
- Runs inherit opsd's environment, so agents act as your accounts; task events record which agent
  did what. Codex's sandbox blocks network access and `.git` writes. To hide variables from a
  runtime's runs, list them in `opsd.runtimes.<name>.unset_env` (on Windows the names match in any
  case). That removes only the variables: credential stores such as the GitHub CLI's keyring login,
  Git Credential Manager and SSH agents stay reachable as you.
- Each run has a time budget (default 180 minutes, or the agent's `budget` setting), and a token
  budget only when the launch or the task's delegation sets one; there is no default token budget.
  opsd ends runs that pass either.
- Budgets limit runaway runs; they are not a security boundary. With its own token
  (`OPS_RUN_TOKEN`), a run can start a helper, or another run of its own agent, with any time and
  token budget. It cannot change settings such as agent budgets: that is for the human only. A run
  that reads the full token from `opsd.json` can change them, as
  [Agent ids are labels, not logins](#agent-ids-are-labels-not-logins) describes.
- On Windows and Linux, opsd stops the processes a run left behind, tracked by process creation
  time so it never kills an unrelated process with a reused PID. On macOS and other Unix systems,
  `ps` reports creation times only to the second, so opsd lists those processes and stops none.

### Provider credentials

- Agent Ops stores no provider keys and has no field to enter one. Runs use your CLI sign-ins
  (`~/.claude`, `~/.codex`) and the API keys in your environment (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY` and the like). `ops doctor` checks only whether a sign-in exists; it never reads
  the files.
- A run inherits opsd's whole environment. The only variables removed are those in the runtime's
  `unset_env`; by default that is `GITHUB_TOKEN` and `GH_TOKEN` for Codex, and nothing for Claude.
- Tasks and comments are checked for secrets when written, but run logs are not: the logs in
  `~/.agent-ops/opsd/logs/` hold whatever an agent prints, so keep them on your machine.

### Webhooks and notifications

Webhook URLs are secrets: they stay in the user config, and the API reports only whether one is
set. The leak check recognizes Slack and Discord webhook URLs only. `notify.webhook` accepts any
https URL, so the leak check does not flag a webhook URL of another kind.

### Updates

The Windows app updates from this repository's GitHub Releases over HTTPS, and checks each
download against the SHA-512 in `latest.yml`. The installer is not code-signed yet, so update
signatures are not verified; anyone who can publish a release here can ship an update. Signing is
planned.

## Supported versions

Only the newest release gets fixes.
