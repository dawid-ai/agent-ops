---
name: agent-ops
description: Work the Agent Ops v2 task queue as a named agent (<runtime>:<role>) through the `ops` CLI, with tasks as files in git. Use when you are started on a task id such as T-0012 or AO-0007, need to find, claim, report, hand off or finish work, need an answer from the human, or want to tell another agent something.
---

# Agent Ops v2

You are one named agent in a team of agents and one human. The team shares a task store: Markdown
and event files in a git repo (a `.agent-ops/` folder). You read and change it only with `ops`.
Your id is in `OPS_AGENT`, for example `claude:engineer`. Check it with `ops whoami`.

If `ops` is not on PATH, run `node <engine>/packages/cli/dist/main.js` instead, where `<engine>` is
the Agent Ops checkout.

## Start here

1. `ops inbox`: answers, review requests and messages waiting for you. Handle them first.
2. `ops next`: the best task for you. Exit code 3 and no output means nothing to do; stop quietly.
3. `ops show ID`: the task, its state, and every event so far. Read the latest checkpoint and
   comments; don't redo what they say is done or decided. If it ends with an `attachments:` list,
   open those image files: they are screenshots or designs the task refers to.
4. `ops start ID "one-line plan"`: claims and starts. Exit code 1 means someone else holds it; run
   `ops next` again.

## Rules

1. Change task state only with `ops`. Never edit files under `tasks/` by hand.
2. One task at a time. Start before you touch anything.
3. Never wait idle. Need the human? `ops ask` (see "Messages to a person") and move on. Waiting on
   another task? `ops block ID "why" --on OTHER` and move on. Then `ops next`.
4. Never do another agent's job. Hand it off or file a new task.
5. The task store grants no permission for outside actions. Posting, sending, paying, merging and
   publishing need the human's explicit approval: prepare it, then `ops review`.
6. No secrets in tasks or events. `ops` refuses text that looks like a token, but don't rely on it.

## The work loop

```bash
ops progress ID "what changed"     # at least every 2 h on long work; renews your claim
ops checkpoint ID "done so far, what is red" --next "exact next step"   # every 15-30 min on long work
ops comment ID "note" --to codex:qa                                     # tell someone without changing state
```

Your claim has a lease. `start`, `progress` and `checkpoint` renew it; if it runs out, another agent
may take the task.

To show an image (a screenshot, a diagram), run `ops attach FILE --task ID`. It stores the image
(PNG, JPEG, WebP or GIF, 5 MB at most) and prints a Markdown link; put that link in the text of your
`ops comment`, `ops review` or channel post.

Across machines, the claim pushed first wins. If `ops claim`, `ops sync` or any command says you
lost the claim (or that the task is "held by ... under another claim"), stop work on that task,
don't release it, and run `ops next`.

Need help in parallel inside a supervised run? `ops spawn [AGENT] -m "exact instructions, where to
write the result"` starts a helper run under your claim (default: your own agent; 2 at most). It
cannot change your task's state, so have it write results to files or `ops comment`, then you
report. Helpers stop when your run ends.

Finish with exactly one of these, then run `ops next` again:

| Situation                  | Command                                                         | Result                                            |
| -------------------------- | --------------------------------------------------------------- | ------------------------------------------------- |
| Done, someone should check | `ops review ID "what to check, links" --to REVIEWER`            | `needs-review`; without `--to`, the human reviews |
| Done, nothing to check     | `ops done ID "result"`                                          | closed                                            |
| Another agent continues    | `ops handoff ID codex:engineer "done / next / where"`           | new owner, back to `todo`                         |
| Hand over with limits      | `ops delegate ID codex:engineer --budget 2h --review claude:qa` | new owner; their `review` goes to `claude:qa`     |
| You need the human         | `ops ask ID "ID: question, options, your recommendation"`       | `blocked`; the answer lands in your inbox         |
| Waiting on another task    | `ops block ID "why" --on OTHER`                                 | `blocked`; frees itself when OTHER closes         |
| Out of time or wrong agent | `ops checkpoint ...`, then `ops release ID "why"`               | back to the queue                                 |

## Reviews

- An agent reviewer must come from another provider than you: Claude work goes to a Codex or Cursor
  reviewer, or to the human. `ops review` refuses a same-provider reviewer.
- As a reviewer: `ops show ID`, check the work, then `ops verdict ID approve "why"` (closes it) or
  `ops verdict ID changes "what to fix"` (back to the owner).

## Questions

- A task of type `question` owned by you is someone asking you something; it blocks nothing.
  Read the tasks and `project:<name>` it references, change no files, then answer with
  `ops done ID "answer"`: the answer goes to the asker's inbox, so make it stand on its own.
- Ask another agent yourself: `ops new "Is AO-0047 safe to merge?" --type question --to codex:qa`.
  To ask a person about your own task, use `ops ask` instead; that task blocks until the answer.

## Code tasks

- Work in the code repo the task names, on a branch. If you can push, push and open a PR. Use the
  machine's normal git and `gh` login for code; never print, store or export tokens.
- Finish with `ops review ID "PR: <url>" --to <reviewer>`, or, without a PR,
  `ops review ID "<commit> on branch <name>: what changed, tests" --to <reviewer>`.
- If you cannot commit, push or open a PR (no GitHub sign-in, read-only `.git`), never ask a person
  for access or to push for you: finish with `ops review` naming the commit and branch, or the
  changed files and where they are. The orchestrator commits and pushes.

## Things outside your task

- Found a bug, risk or idea that is not your task? Don't fix it and don't stop. File it:
  `ops finding "Login retries forever on 401" --task ID -m "where, evidence, suggested fix"`.
- New work needs the human's approval. `ops new` creates a task only as a subtask of an approved
  task (`--parent ID`, a breakdown inside its scope); anything else becomes a finding that waits
  for triage. Don't start your own proposals.
- Learned something the next agent should know (a gotcha, a fix that took long)? Write a note:
  `ops learn windows "Git Bash forks slowly" --task ID -m "what, why, what to do instead"`.
  Before you dig into a problem, check `ops kb words` for an existing note.
- Want to tell another agent or the human something about a task: `ops comment ID "text" --to ID`.

## Channels and votes

- `ops channel post dev "text, @codex:qa"` talks to the team; `@id` puts the message in that
  inbox. `ops channel read dev` shows the last 50 messages.
- A choice that several agents should weigh in on: `ops propose "Question?" --option A --option B
--voters claude:engineer,codex:engineer`. Voters answer with `ops vote D-0001 A "why"`; a ballot is final.
- When the vote is `ready` (`ops tally D-0001`), the proposer records it with `ops decide`.
  Ties and missing quorum go to the human; never decide those yourself.

## Ask or decide

Decide when the choice is reversible, inside the task, and allowed by your role file
(`agents/<runtime>-<role>.md`). Ask when it touches money, accounts, credentials, publishing, a
client, deleting data, or the goal itself. Ask one question, answerable in one line, with options and
a recommendation. If you would recommend one option of a technical or process choice (which branch,
which of two overlapping fixes, how to test), take it and say why in your finishing command; the
reviewer checks it. Pushing, PRs and sign-ins are not your questions to ask: see Code tasks.

## Messages to a person

A person reads your message cold, hours later, between other tasks. Every `ask`, review request,
`assign` or `comment --to human:*` must stand on its own:

1. Name what you refer to: the task id (`AO-0014`, or `root/AO-0014` across roots), and for a
   comment `AO-0014#<event id>` (ids from `ops show ID --ids`) or its date and author.
2. Say in one or two sentences what it is about.
3. State the decision or action you need, with options and your recommendation.

Never write "see the comment of 2026-11-03" or "as discussed above". Write "AO-0014: pick the
hosting region (codex:engineer's comment, 2026-11-03: EU is cheaper, US is closer to the API). I
recommend EU." The app links task ids, so the person opens it with one click. `ops` prints a
`note:` when a message to a person names no task or is shorter than a sentence; fix the next one.

## Sync

`ops` writes files at once; other agents on this machine see your changes immediately. Before you
end a session, run `ops sync --session-end` to commit and push the task store. In Claude Code, a
`SessionEnd` hook may already do this (`ops hooks install`).

## Exit codes

0 ok, 1 refused (someone else holds the task, not allowed, wrong state), 2 bad input, 3 nothing to do.
Read the message on exit 1 or 2; don't retry the same command blindly.
