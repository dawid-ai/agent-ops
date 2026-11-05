# Contributing

## Setup

```sh
npm install        # also points git hooks at .githooks (pre-commit leak check)
npm run build
npm test
```

Node.js 22 or later. On Windows, use Git Bash or PowerShell; the repo keeps LF line endings
(`.gitattributes`).

## Layout

| Path                  | Contents                                              |
| --------------------- | ----------------------------------------------------- |
| `packages/core`       | Data model, fold, file store, index, sync, leak check |
| `packages/cli`        | The `ops` command                                     |
| `packages/supervisor` | `opsd` (phase 2)                                      |
| `packages/desktop`    | Electron app (phase 3)                                |
| `scripts/`            | Repo tools: leak check, hook setup, benchmark         |
| `docs/`               | Protocol and design notes                             |

## Before you push

1. `npm run lint`, `npm run typecheck` and `npm test` pass.
2. Add a changelog fragment in `changelog.d/` for any change users notice (see
   [changelog.d/README.md](changelog.d/README.md)). Don't edit `CHANGELOG.md` directly.
3. Keep commits free of tokens, keys and webhook URLs; the pre-commit hook checks staged files.

## Commits

- Subject in the imperative, sentence case, no period, at most 72 characters.
- Body explains what and why.

CI runs on Linux only (lint, typecheck, unit tests) and only when code paths change.
