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
| Settings form | `manifest.json` · `user_config` → `server/config.js` | 笔记文件夹 (a folder) and 样例目录地址 (an address): Spica draws the form under 设置 › 插件 › Notes › 详情, stores the values and hands them to the servers as `SPICA_USER_CONFIG` |
| Page of its own | `views/connection-test.json` → `ui/connection-test.*`, `services/connection-test.json` → `server/connection-test.js` | 测试连接, a tab after 详情: tries the catalog address once. What a form cannot do; it stores nothing |

Notes are stored in the plugin's data folder, which survives updates. With mock mode
off and no 样例目录地址 in the settings form, `search_catalog` explains that
the service is not configured and suggests mock mode.

`summarize_note` asks the model the user has set up in Spica for a summary (MCP sampling).
The manifest asks for it in `permissions.model` with a reason; the plugin has no key of its own
and no dollar limit (a plugin that wants one limits its own calls). The user can forbid it on the plugin page.

Try it: `npm run smoke:plugins -w @spica/plugins` installs this plugin, calls a tool,
disables it and checks the tools are gone.
