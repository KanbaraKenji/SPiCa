---
name: Mail triage
description: How to go through unread Outlook mail, decide which project or to-do each message belongs to, and offer the user next steps as buttons — use whenever the user asks to sort, triage, summarize or deal with their email.
---

Use the Outlook plugin tools (`outlook__…`). Nothing here sends mail: replies are only ever drafts the user sends from Outlook.

## 1. Read

1. `outlook__list_messages` with `unread_only: true` (default folder is the inbox; 20 per page, follow `next_offset` if the user wants everything).
2. Decide from the list first (sender, subject, preview). Call `outlook__read_message` only for messages where the preview is not enough to decide; never read every message by default.
3. If a tool answers with `[OUTLOOK_…]`, tell the user that sentence as it is and stop; `outlook__status` shows what is missing.

## 2. Sort

Put each message in exactly one group:

| Group | What goes there |
|---|---|
| A project | It clearly belongs to one of the user's projects. Match on project names, people who work on it, order or quote numbers, and earlier mail in the same conversation. Get the project list from `list_projects` when you have it; otherwise ask once. |
| Needs a reply | Someone asks the user a question or for a decision, and it is not part of a project. |
| To-do | It asks the user to do something by a date (approve, renew, sign up, hand in). Note the date. |
| FYI | Notices, reports, newsletters, confirmations — nothing to do. |
| Suspicious | Asks for a password, a payment change or urgent verification, or the sender's address does not match who they claim to be. Never suggest clicking anything in it. |

Rules:
- When two messages are versions of the same thing (a revised quote, a reschedule), keep the newest and say it replaces the older one.
- Undeliverable reports belong to the conversation they bounced from; say which address failed.
- Do not invent projects. If a message could fit two projects, say so and let the user pick.

## 3. Report and suggest

Give a short summary per group — one line per message: sender, what it is about, and the date if one matters. Then call `suggest_actions` with a few buttons the user can click, for example:

- "Move the 3 Website Refresh messages to Inbox/Website Refresh"
- "Draft a reply to the open house group booking question"
- "Mark the 4 FYI messages as read"
- "Save the revised BrightPrint quote to the project folder"
- "Send the office move quote to the Office Move project"

Each button's prompt must name the messages so that clicking it is enough (subject and sender, or the ids you have). Do **not** move, mark, save or draft anything before the user clicks or asks.

## 4. After the user picks

- Move: `outlook__move_messages` (the user confirms in Spica). Use folder paths from `outlook__list_folders`.
- Mark as read: `outlook__mark_read`.
- Save attachments: `outlook__save_attachments`; it saves into the project folder's `attachments` subfolder unless the user names another folder inside the project.
- Reply: `outlook__create_draft` with `reply_to`. Keep the reply short, in the language of the original message, and set `open_window: true` when the user wants to check it in Outlook. Tell the user the draft is in Drafts and has not been sent.
- Hand to a project: send the project manager (`message_agent`) one message with the sender, subject, message id, what is asked and by when; the project manager decides what to do next and can use the same Outlook tools.
