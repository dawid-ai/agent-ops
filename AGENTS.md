# Instructions for agents working on this repo

This repo is the Agent Ops engine, v2. Read [README.md](README.md) and
[docs/protocol.md](docs/protocol.md) first.

## Rules

- No AI attribution anywhere: no `Co-Authored-By` trailers, no "Generated with" lines in commits,
  PRs, docs or comments. Commits are authored by the repo owner's git identity.
- No secrets: never print, commit or log tokens, keys, `.pem` files or webhook URLs.
- Kill only processes you started, by the PID your own command printed.
- Don't install global tools or change global config. `npm install` inside the repo is fine.
- Commit locally as you go; push only when asked or at session end.

## Working a task

1. `npm run build`, then use `npm run ops -- <command>` or `node packages/cli/dist/main.js`.
2. Set `OPS_AGENT` to your id (`claude:engineer`, `codex:engineer`).
3. `ops next`, `ops start ID "plan"`, `ops progress ID "..."` at least every 2 hours.
4. Commit on a task branch, then finish with
   `ops review ID "<commit> on branch <name>: what changed, tests" --to <reviewer from another provider>`.
   No push or PR for this repo; the orchestrator merges into `v2` after approval. If you cannot
   commit (read-only `.git`), name the changed files in the review instead; never ask a person for
   access.
5. Every message to a person (`ask`, `review`, `assign`, `comment --to human:*`) names the task
   id, and `ID#<event id>` (from `ops show ID --ids`) or the date and author for a comment; says
   in one or two sentences what it is about; and states the decision or action needed. Never
   write "see the comment of <date>". See "Messages to a person" in
   [docs/protocol.md](docs/protocol.md).

## Code

- TypeScript, strict, ES modules, Node 22+. Core is synchronous file I/O; keep it that way unless a
  caller needs async.
- Every child process sets `windowsHide: true`.
- Tests next to the package in `test/`, run with `npm test`; add one for each behavior change.
