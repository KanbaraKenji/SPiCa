# Notes (example plugin)

An example Spica plugin that shows every part of the plugin format:

| Part | File | What it does |
|---|---|---|
| Manifest | `manifest.json` | Name `notes`, version, permissions, mock support |
| MCP server | `mcp/notes.json` → `server/index.js` | Node server run with Spica's own Node: `list_notes`, `read_note`, `write_note`, `delete_note` (needs confirmation), `search_catalog` |
| Skill | `skills/note-taking/SKILL.md` | How to keep tidy notes |
| Command | `commands/note.md` | `/notes:note <text>` saves something to the notebook |
| Hook | `hooks/notes-hint.js` | Injects one line after the system prompt |
| Mock data | `mock/catalog.json` | A fictional book catalog used when mock mode is on |

Notes are stored in the plugin's data folder, which survives updates. With mock mode
off and no `CATALOG_URL` configured, `search_catalog` explains that the service is not
reachable and suggests mock mode.

Try it: `npm run smoke:plugins -w @spica/plugins` installs this plugin, calls a tool,
disables it and checks the tools are gone.
