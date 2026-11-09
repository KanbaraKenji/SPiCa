// Tool declarations, argument checks and result formatting. The backend
// (mock or real Outlook) does the work; both get the same checked arguments
// and return plain objects, so the tools behave the same in both modes.
import { isAbsolute } from 'node:path';
import { MailError, formatError } from './errors.js';

const ids = { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50, description: 'Message ids from list_messages.' };

export const TOOLS = [
  {
    name: 'status',
    description: 'Check whether Outlook can be read: mode (mock or real), whether classic Outlook is installed, has a profile and is running, and the mailbox accounts. Call this first when another Outlook tool fails.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_folders',
    description: 'List mail folders with unread and total counts. Paths look like "Inbox/Website Refresh"; well-known folders also have an alias (inbox, drafts, sent, deleted, junk, outbox).',
    inputSchema: {
      type: 'object',
      properties: { mailbox: { type: 'string', description: 'Mailbox display name; default is the main mailbox.' } },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_messages',
    description: 'List messages in one folder, newest first, with filters and paging. Returns ids, sender, subject, time, unread flag, attachments flag and a short preview — not the full body (use read_message).',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Folder path or alias; default "inbox".' },
        mailbox: { type: 'string' },
        unread_only: { type: 'boolean' },
        from: { type: 'string', description: 'Part of the sender name or address.' },
        query: { type: 'string', description: 'Text to find in subject, sender or body.' },
        since: { type: 'string', description: 'ISO date or date-time; received at or after.' },
        until: { type: 'string', description: 'ISO date or date-time; received at or before (a date means the end of that day).' },
        has_attachments: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 20.' },
        offset: { type: 'integer', minimum: 0 },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'read_message',
    description: 'Read one message: headers, body (plain text by default) and the attachment list. Reading does not mark the message as read.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        format: { type: 'string', enum: ['text', 'html'], description: 'Default "text".' },
        max_chars: { type: 'integer', minimum: 200, maximum: 100000, description: 'Body length limit, default 8000.' },
      },
      required: ['id'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'mark_read',
    description: 'Mark messages as read (or unread again with unread: true).',
    inputSchema: { type: 'object', properties: { ids, unread: { type: 'boolean' } }, required: ['ids'] },
  },
  {
    name: 'move_messages',
    description: 'Move messages to another folder. Ids change after a move; the result lists the new ids. Asks the user first.',
    inputSchema: {
      type: 'object',
      properties: { ids, folder: { type: 'string', description: 'Target folder path or alias.' }, mailbox: { type: 'string' } },
      required: ['ids', 'folder'],
    },
  },
  {
    name: 'save_attachments',
    description: 'Save attachments of one message into the project folder (default subfolder "attachments"). Existing files are kept and the new file gets " (1)" unless overwrite is true (which asks the user first).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        dest_folder: { type: 'string', description: 'Folder inside the project folder; relative paths start at the project folder.' },
        names: { type: 'array', items: { type: 'string' }, description: 'Attachment file names; omit to save all.' },
        overwrite: { type: 'boolean' },
      },
      required: ['id'],
    },
  },
  {
    name: 'create_draft',
    description: 'Create a draft in the Drafts folder — a reply (reply_to) or a new message. Never sends. With open_window the draft opens in Outlook for the user to review and send.',
    inputSchema: {
      type: 'object',
      properties: {
        reply_to: { type: 'string', description: 'Id of the message to reply to.' },
        reply_all: { type: 'boolean' },
        to: { type: 'array', items: { type: 'string' } },
        cc: { type: 'array', items: { type: 'string' } },
        subject: { type: 'string', description: 'Required for a new message; for a reply it replaces "RE: …".' },
        body: { type: 'string', description: 'Plain text; for a reply it goes above the quoted message.' },
        open_window: { type: 'boolean' },
      },
      required: ['body'],
    },
  },
];

const bad = (detail) => new MailError('INVALID_ARGUMENT', detail);

function str(v, name, { required = false, max = 2000 } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`缺少 ${name}。`);
    return undefined;
  }
  if (typeof v !== 'string') throw bad(`${name} 应该是文字。`);
  if (v.length > max) throw bad(`${name} 太长（最多 ${max} 字）。`);
  return v;
}

function bool(v, name) {
  if (v === undefined || v === null) return false;
  if (typeof v !== 'boolean') throw bad(`${name} 应该是 true 或 false。`);
  return v;
}

function int(v, name, min, max, dflt) {
  if (v === undefined || v === null) return dflt;
  if (!Number.isInteger(v) || v < min || v > max) throw bad(`${name} 应该是 ${min} 到 ${max} 之间的整数。`);
  return v;
}

function strList(v, name, { required = false, max = 50 } = {}) {
  if (v === undefined || v === null) {
    if (required) throw bad(`缺少 ${name}。`);
    return undefined;
  }
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x === '')) throw bad(`${name} 应该是文字列表。`);
  if (required && v.length === 0) throw bad(`${name} 不能为空。`);
  if (v.length > max) throw bad(`${name} 一次最多 ${max} 个。`);
  return v;
}

/** ISO date / date-time → ISO instant. A bare date is local midnight (or end of day for `until`). */
export function parseWhen(v, name, endOfDay = false) {
  const s = str(v, name, { max: 40 });
  if (s === undefined) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = m
    ? endOfDay
      ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999)
      : new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    : new Date(s);
  if (Number.isNaN(d.getTime())) throw bad(`${name}「${s}」不是日期，请用 2026-11-09 或 2026-11-09T14:00 这样的写法。`);
  return d.toISOString();
}

/** Checked arguments per tool. */
export const CHECK = {
  status: () => ({}),
  list_folders: (a) => ({ mailbox: str(a.mailbox, 'mailbox', { max: 200 }) }),
  list_messages: (a) => {
    const out = {
      folder: str(a.folder, 'folder', { max: 400 }) ?? 'inbox',
      mailbox: str(a.mailbox, 'mailbox', { max: 200 }),
      unread_only: bool(a.unread_only, 'unread_only'),
      from: str(a.from, 'from', { max: 200 }),
      query: str(a.query, 'query', { max: 200 }),
      since: parseWhen(a.since, 'since'),
      until: parseWhen(a.until, 'until', true),
      has_attachments: bool(a.has_attachments, 'has_attachments'),
      limit: int(a.limit, 'limit', 1, 50, 20),
      offset: int(a.offset, 'offset', 0, 100000, 0),
    };
    if (out.since && out.until && out.since > out.until) throw bad('since 晚于 until。');
    return out;
  },
  read_message: (a) => ({
    id: str(a.id, 'id', { required: true, max: 1000 }),
    format: a.format === undefined ? 'text' : ['text', 'html'].includes(a.format) ? a.format : (() => { throw bad('format 只能是 text 或 html。'); })(),
    max_chars: int(a.max_chars, 'max_chars', 200, 100000, 8000),
  }),
  mark_read: (a) => ({ ids: strList(a.ids, 'ids', { required: true }), unread: bool(a.unread, 'unread') }),
  move_messages: (a) => ({
    ids: strList(a.ids, 'ids', { required: true }),
    folder: str(a.folder, 'folder', { required: true, max: 400 }),
    mailbox: str(a.mailbox, 'mailbox', { max: 200 }),
  }),
  save_attachments: (a) => {
    const dest = str(a.dest_folder, 'dest_folder', { max: 1000 });
    // Inside Spica the plugin's hook has already turned this into an absolute
    // path inside the project folder; without the hook there is no project
    // folder to resolve against.
    if (!dest || !isAbsolute(dest)) throw new MailError('PATH_NOT_ALLOWED', '没有拿到项目文件夹（dest_folder 需要是项目文件夹里的完整路径）。');
    return {
      id: str(a.id, 'id', { required: true, max: 1000 }),
      dest_folder: dest,
      names: strList(a.names, 'names'),
      overwrite: bool(a.overwrite, 'overwrite'),
    };
  },
  create_draft: (a) => {
    const out = {
      reply_to: str(a.reply_to, 'reply_to', { max: 1000 }),
      reply_all: bool(a.reply_all, 'reply_all'),
      to: strList(a.to, 'to') ?? [],
      cc: strList(a.cc, 'cc') ?? [],
      subject: str(a.subject, 'subject', { max: 400 }),
      body: str(a.body, 'body', { required: true, max: 50000 }),
      open_window: bool(a.open_window, 'open_window'),
    };
    if (!out.reply_to && out.to.length === 0) throw bad('新邮件需要 to（收件人）；回复请给 reply_to。');
    if (!out.reply_to && !out.subject) throw bad('新邮件需要 subject（主题）。');
    if (out.reply_all && !out.reply_to) throw bad('reply_all 只用于回复（需要 reply_to）。');
    return out;
  },
};

const METHOD = {
  status: 'status',
  list_folders: 'listFolders',
  list_messages: 'listMessages',
  read_message: 'readMessage',
  mark_read: 'markRead',
  move_messages: 'moveMessages',
  save_attachments: 'saveAttachments',
  create_draft: 'createDraft',
};

/**
 * Run one tool. Returns { text, isError } or null for an unknown tool.
 * `log` gets only counts, timings and folder names — never mail content.
 */
export async function callTool(backend, name, rawArgs, log = () => {}) {
  if (!CHECK[name]) return null;
  const t0 = Date.now();
  try {
    const args = CHECK[name](rawArgs ?? {});
    const result = await backend[METHOD[name]](args);
    log(`${name} ok ${Date.now() - t0}ms${summary(name, args, result)}`);
    const head = backend.mock ? '[sample data — mock mode]\n' : '';
    return { text: head + JSON.stringify(result, null, 1), isError: false };
  } catch (err) {
    const code = err instanceof MailError ? err.code : 'COM_ERROR';
    log(`${name} failed ${Date.now() - t0}ms ${code}${err?.hresult ? ` ${err.hresult}` : ''}${err instanceof MailError ? '' : ` ${err?.name ?? 'Error'}`}`);
    const head = backend.mock ? '[sample data — mock mode]\n' : '';
    return { text: head + formatError(err), isError: true };
  }
}

/** Log-safe summary: counts and folder names only. */
function summary(name, args, r) {
  switch (name) {
    case 'list_folders':
      return ` folders=${r.folders?.length ?? 0}`;
    case 'list_messages':
      return ` folder=${JSON.stringify(args.folder)} count=${r.messages?.length ?? 0} total=${r.total ?? '?'}`;
    case 'read_message':
      return ` attachments=${r.attachments?.length ?? 0} chars=${r.body?.length ?? 0}`;
    case 'mark_read':
      return ` changed=${r.changed ?? 0}`;
    case 'move_messages':
      return ` folder=${JSON.stringify(args.folder)} moved=${r.moved?.length ?? 0}`;
    case 'save_attachments':
      return ` saved=${r.saved?.length ?? 0}`;
    case 'create_draft':
      return ` reply=${args.reply_to ? 'yes' : 'no'} window=${r.opened_window ? 'yes' : 'no'}`;
    default:
      return '';
  }
}
