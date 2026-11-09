// Mock backend: a fictional mailbox (mock/mailbox.json) held in memory.
// Writes (mark read, move, drafts) last until the server restarts, so a
// whole triage flow can run; attachments are really written to disk.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MailError } from './errors.js';
import { targetPath } from './files.js';

const DAY = 86_400_000;
const ALIASES = { inbox: 'Inbox', drafts: 'Drafts', sent: 'Sent Items', deleted: 'Deleted Items', junk: 'Junk Email', outbox: 'Outbox' };

export class MockBackend {
  mock = true;

  /** @param {string} file mailbox.json @param {{ now?: Date }} [opts] */
  constructor(file, opts = {}) {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    this.account = data.account;
    this.folders = data.folders.map((f) => ({ ...f }));
    // Shift whole days so the newest message lands on today; keeps times of day.
    const now = opts.now ?? new Date();
    const newest = Math.max(...data.messages.map((m) => Date.parse(m.received)));
    const shift = Math.max(0, Math.floor((startOfDay(now) - startOfDay(new Date(newest))) / DAY)) * DAY;
    this.messages = data.messages.map((m) => ({
      ...m,
      received: new Date(Date.parse(m.received) + shift).toISOString(),
      attachments: m.attachments.map((a, i) => ({ index: i + 1, name: a.name, size: Buffer.byteLength(a.content, 'utf8'), content: a.content })),
    }));
    this.nextDraft = 1;
  }

  folderPath(name) {
    const raw = String(name).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const [first, ...rest] = raw.split('/');
    const base = ALIASES[first.toLowerCase()] ?? first;
    const path = [base, ...rest].join('/');
    const hit = this.folders.find((f) => f.path.toLowerCase() === path.toLowerCase());
    if (!hit) throw new MailError('FOLDER_NOT_FOUND', `「${name}」不存在。`);
    return hit.path;
  }

  checkMailbox(mailbox) {
    if (mailbox && mailbox.toLowerCase() !== this.account.display_name.toLowerCase() && mailbox.toLowerCase() !== this.account.address) {
      throw new MailError('FOLDER_NOT_FOUND', `没有叫「${mailbox}」的邮箱。`);
    }
  }

  message(id) {
    const m = this.messages.find((x) => x.id === id);
    if (!m) throw new MailError('MESSAGE_NOT_FOUND');
    return m;
  }

  async status() {
    return {
      mode: 'mock',
      outlook: { installed: true, profile: true, running: true, version: 'sample' },
      mailboxes: [{ name: this.account.display_name, address: this.account.address, default: true }],
    };
  }

  async listFolders({ mailbox }) {
    this.checkMailbox(mailbox);
    return {
      mailbox: this.account.display_name,
      folders: this.folders.map((f) => {
        const inside = this.messages.filter((m) => m.folder === f.path);
        return { path: f.path, ...(f.alias ? { alias: f.alias } : {}), unread: inside.filter((m) => m.unread).length, total: inside.length };
      }),
    };
  }

  async listMessages(a) {
    this.checkMailbox(a.mailbox);
    const folder = this.folderPath(a.folder);
    const has = (v, q) => String(v ?? '').toLowerCase().includes(q.toLowerCase());
    const rows = this.messages
      .filter((m) => m.folder === folder)
      .filter((m) => !a.unread_only || m.unread)
      .filter((m) => !a.has_attachments || m.attachments.length > 0)
      .filter((m) => !a.from || has(m.from_name, a.from) || has(m.from_address, a.from))
      .filter((m) => !a.query || has(m.subject, a.query) || has(m.body, a.query) || has(m.from_name, a.query))
      .filter((m) => !a.since || m.received >= a.since)
      .filter((m) => !a.until || m.received <= a.until)
      .sort((x, y) => (x.received < y.received ? 1 : -1));
    const page = rows.slice(a.offset, a.offset + a.limit);
    return {
      folder,
      total: rows.length,
      offset: a.offset,
      next_offset: a.offset + page.length < rows.length ? a.offset + page.length : null,
      messages: page.map((m) => ({
        id: m.id,
        kind: m.kind,
        from_name: m.from_name,
        from_address: m.from_address,
        subject: m.subject,
        received: localIso(m.received),
        unread: m.unread,
        has_attachments: m.attachments.length > 0,
        importance: m.importance,
        categories: m.categories,
        preview: preview(m.body),
      })),
    };
  }

  async readMessage({ id, format, max_chars }) {
    const m = this.message(id);
    const full = format === 'html' ? toHtml(m.body) : m.body;
    return {
      id: m.id,
      kind: m.kind,
      folder: m.folder,
      from_name: m.from_name,
      from_address: m.from_address,
      to: m.to,
      cc: m.cc,
      subject: m.subject,
      received: localIso(m.received),
      unread: m.unread,
      importance: m.importance,
      categories: m.categories,
      conversation: m.subject.replace(/^(re|fw|fwd|回复|转发)\s*[:：]\s*/i, ''),
      format,
      body: full.slice(0, max_chars),
      truncated: full.length > max_chars,
      attachments: m.attachments.map((x) => ({ index: x.index, name: x.name, size: x.size })),
    };
  }

  async markRead({ ids, unread }) {
    const items = ids.map((id) => this.message(id));
    let changed = 0;
    for (const m of items) {
      if (m.unread !== unread) changed++;
      m.unread = unread;
    }
    return { changed, unread };
  }

  async moveMessages({ ids, folder, mailbox }) {
    this.checkMailbox(mailbox);
    const target = this.folderPath(folder);
    const items = ids.map((id) => this.message(id));
    for (const m of items) m.folder = target;
    return { folder: target, moved: items.map((m) => ({ old_id: m.id, id: m.id })) };
  }

  async saveAttachments({ id, dest_folder, names, overwrite }) {
    const m = this.message(id);
    const picked = names ? names.map((n) => pickAttachment(m, n)) : m.attachments;
    mkdirSync(dest_folder, { recursive: true });
    const taken = new Set();
    const saved = picked.map((a) => {
      const path = targetPath(dest_folder, a.name, overwrite, taken);
      writeFileSync(path, a.content);
      return { name: a.name, path, size: a.size };
    });
    return { folder: dest_folder, saved };
  }

  async createDraft(a) {
    let draft;
    if (a.reply_to) {
      const orig = this.message(a.reply_to);
      const me = this.account.address;
      const to = [orig.from_address, ...(a.reply_all ? orig.to.filter((x) => x !== me) : []), ...a.to];
      const cc = [...(a.reply_all ? orig.cc.filter((x) => x !== me) : []), ...a.cc];
      const quoted = `\n\n-----Original Message-----\nFrom: ${orig.from_name} <${orig.from_address}>\nSubject: ${orig.subject}\n\n${orig.body}`;
      draft = { to: unique(to), cc: unique(cc), subject: a.subject ?? `RE: ${orig.subject}`, body: a.body + quoted };
    } else {
      draft = { to: a.to, cc: a.cc, subject: a.subject, body: a.body };
    }
    const id = `mock-draft-${String(this.nextDraft++).padStart(3, '0')}`;
    this.messages.push({
      id,
      folder: 'Drafts',
      kind: 'mail',
      unread: false,
      importance: 'normal',
      from_name: this.account.display_name,
      from_address: this.account.address,
      to: draft.to,
      cc: draft.cc,
      subject: draft.subject,
      received: new Date().toISOString(),
      categories: [],
      body: draft.body,
      attachments: [],
    });
    return { id, folder: 'Drafts', subject: draft.subject, to: draft.to, cc: draft.cc, opened_window: false, sent: false };
  }
}

function pickAttachment(m, name) {
  const a = m.attachments.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!a) throw new MailError('ATTACHMENT_NOT_FOUND', `没有「${name}」。`);
  return a;
}

const unique = (xs) => [...new Set(xs)];
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export function preview(body) {
  const flat = String(body ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
}

/** ISO instant → local time with offset, the same shape the real backend returns. */
export function localIso(iso) {
  const d = new Date(iso);
  const off = -d.getTimezoneOffset();
  const pad = (n) => String(Math.abs(n)).padStart(2, '0');
  const local = new Date(d.getTime() + off * 60_000).toISOString().slice(0, 19);
  return `${local}${off >= 0 ? '+' : '-'}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
}

function toHtml(text) {
  const esc = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<html><body><p>${esc.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p></body></html>`;
}

export const MOCK_FILE = (pluginDir) => join(pluginDir, 'mock', 'mailbox.json');
