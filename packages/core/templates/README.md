# Templates

Starter files for a data root (`.agent-ops/`). Copy the ones you want into the matching folder of
your root and edit them for your team.

- `agents/<runtime>-<role>.md` defines one agent role: YAML frontmatter (`id`, `name`,
  `description`, `status`, `can_claim`, `projects`, `model`, `budget_min`, and optional `tools` and
  `mcp`) followed by the role's instructions in Markdown.
- `people/owner.md` defines the human who reviews work and answers asks.

The file name is the id with `:` replaced by `-`. For example, `claude:qa` lives in
`agents/claude-qa.md`.

`tools` lists the tool rules a role may use, and `mcp` lists the names of its MCP servers. Neither
holds URLs or secrets. `ops` records them for now; the phase 2 supervisor builds each role's
permission profile from them.

Roles with `status: proposed` take no work until you set them to `active`.
