# Outlook mail (official plugin)

Reads mail from the **classic Outlook desktop app** on this computer, helps the
agent sort it and drafts replies. It never sends mail: drafts go to the Drafts
folder and the user sends them from Outlook.

| Part | File | What it does |
|---|---|---|
| Manifest | `manifest.json` | Name `outlook` (tools are `outlook__…`); `move_messages` needs confirmation |
| MCP server | `mcp/outlook.json` → `server/index.js` | `status`, `list_folders`, `list_messages`, `read_message`, `mark_read`, `move_messages`, `save_attachments`, `create_draft` |
| Outlook access | `server/outlook.ps1` | Windows PowerShell 5.1 (built into Windows) talks to the running Outlook over COM; hidden window, no install, no admin |
| Hook | `hooks/guard.js` | Keeps `save_attachments` inside the session's project folder; overwriting asks first |
| Skill | `skills/triage/SKILL.md` | How to sort unread mail and offer next steps as buttons |
| Command | `commands/triage.md` | `/outlook:triage` |
| Mock data | `mock/mailbox.json` | 30 fictional messages used when Spica's mock mode is on |

Needs classic Outlook running with a mail profile. The new Outlook for Windows
has no COM interface and is not supported. When something is missing, every tool
answers with a code and a sentence, e.g. `[OUTLOOK_NOT_RUNNING] …`.

Try it:

```powershell
npm run smoke -w @spica/plugin-outlook-mail                 # mock flow + a check of this computer's Outlook
npm run smoke -w @spica/plugin-outlook-mail -- --real-draft # also put one test draft in the real Drafts folder
npx vitest run plugins/outlook-mail
```

Design notes (Chinese): `docs/design/outlook-mail.md`.
