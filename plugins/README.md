# Official plugins

Official, optional plugins live here, one folder per plugin. Each plugin that ships
code is its own npm workspace named `@spica/plugin-<name>`.

A plugin follows the common plugin-folder layout (skills + MCP servers + commands) and
may add code hooks, background processes and UI views. External processes are always
MCP servers. The format is described in `docs/design/plugins.md`; the author guide is
`docs/plugins/authoring.md`.

| Folder | What it is |
|---|---|
| `example-notes` | Example plugin showing every part: a Node MCP server with mock data, a skill, a command and a hook |
