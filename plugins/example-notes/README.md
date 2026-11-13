# Notes (example plugin)

An example Spica plugin that shows every part of the plugin format:

| Part | File | What it does |
|---|---|---|
| Manifest | `manifest.json` | Name `notes`, version, permissions, mock support |
| MCP server | `mcp/notes.json` → `server/index.js` | Node server run with Spica's own Node: `list_notes`, `read_note`, `write_note`, `delete_note` (needs confirmation), `summarize_note` (uses the model set up in Spica), `search_catalog` |
| Skill | `skills/note-taking/SKILL.md` | How to keep tidy notes |
| Command | `commands/note.md` | `/notes:note <text>` saves something to the notebook |
| Hook | `hooks/notes-hint.js` | Injects one line after the system prompt |
| Hook | `hooks/replace-confirm.js` | Asks before `write_note` overwrites a note (`replace: true`); the confirmation is marked `irreversible`, so the card shows 无法撤销 |
| Mock data | `mock/catalog.json` | A fictional book catalog used when mock mode is on |

Notes are stored in the plugin's data folder, which survives updates. With mock mode
off and no `catalogUrl` in the data folder's `config.json`, `search_catalog` explains that
the service is not configured and suggests mock mode.

`summarize_note` asks the model the user has set up in Spica for a summary (MCP sampling).
The manifest asks for it in `permissions.model` with a reason and a daily limit of 0.1 USD;
the plugin has no key of its own, and Spica refuses once the limit is reached.

Try it: `npm run smoke:plugins -w @spica/plugins` installs this plugin, calls a tool,
disables it and checks the tools are gone.
