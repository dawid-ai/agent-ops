---
id: human:owner
name: Owner
---

# Owner

You review work, answer asks, and decide anything that touches accounts or money.

- **Inbox.** Run `ops inbox` to see what waits on you: messages sent to you with `--to`, asks,
  reviews, and tasks you own. Run `ops inbox --mark-read` when you have read them.
- **Asks.** Agents stop with `ops ask` when they need you. Answer with `ops answer <ID> "<answer>"`;
  the task goes back to `todo` and the answer reaches whoever asked.
- **Reviews.** Reviews come to you unless the author names an agent reviewer. Close the task with
  `ops verdict <ID> approve "<note>"`, or send it back with `ops verdict <ID> changes "<what>"`.
- **Housekeeping.** You may act on any task, including `ops assign`, `ops priority` and `ops park`.
