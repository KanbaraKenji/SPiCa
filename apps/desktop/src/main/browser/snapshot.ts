// What an agent reads of a page: its address, title, text, and the elements it could act on, each with a reference
// number. Worked out inside the page in an isolated world (the page's own scripts cannot see or change the list or
// the references kept for later steps), then laid out here as plain text for the model.

/** The isolated world the browser's agent tools use inside a page (not the page's own). */
export const AGENT_WORLD = 1207;

/** Most characters of page text given back in one read. */
export const TEXT_LIMIT = 12_000;
/** Most elements listed in one read. */
export const ELEMENT_LIMIT = 200;

export interface PageElement {
  ref: number;
  /** link, button, textbox, checkbox, radio, select, … */
  role: string;
  name: string;
  /** A link's address. */
  href?: string;
  /** A text box's current value (not for passwords). */
  value?: string;
  /** password, email, … for inputs. */
  type?: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
  elements: PageElement[];
  more: number;
}

/**
 * Runs in the page's isolated world: lists the visible elements to act on, keeps them in window.__spicaRefs (that
 * world's own window) so a later step can find them by number, and returns the snapshot.
 */
export const SNAPSHOT_SCRIPT = `(() => {
  const TEXT_LIMIT = ${TEXT_LIMIT}, ELEMENT_LIMIT = ${ELEMENT_LIMIT};
  const sel = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=menuitem], [role=option], [role=switch], [role=textbox], [role=combobox], [contenteditable=""], [contenteditable=true]';
  const visible = (el) => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05; };
  const clip = (s, n) => { s = String(s || '').replace(/\\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
  const roleOf = (el) => { const r = el.getAttribute('role'); if (r) return r; const t = el.tagName.toLowerCase(); if (t === 'a') return 'link'; if (t === 'button' || t === 'summary') return 'button'; if (t === 'select') return 'select'; if (t === 'textarea') return 'textbox'; if (t === 'input') { const ty = (el.getAttribute('type') || 'text').toLowerCase(); if (ty === 'checkbox' || ty === 'radio') return ty; if (ty === 'submit' || ty === 'button' || ty === 'reset' || ty === 'image') return 'button'; return 'textbox'; } return el.isContentEditable ? 'textbox' : t; };
  const nameOf = (el) => { const l = el.getAttribute('aria-label'); if (l) return l; if (el.labels && el.labels[0]) return el.labels[0].innerText; const t = el.tagName.toLowerCase(); if (t === 'input' && /^(submit|button|reset)$/i.test(el.type)) return el.value; return el.innerText || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('alt') || el.getAttribute('name') || ''; };
  const all = [...document.querySelectorAll(sel)].filter(visible);
  window.__spicaRefs = all.slice(0, ELEMENT_LIMIT);
  const elements = window.__spicaRefs.map((el, i) => {
    const e = { ref: i + 1, role: roleOf(el), name: clip(nameOf(el), 80) };
    if (el.tagName === 'A') e.href = clip(el.href, 200);
    if (el.tagName === 'INPUT') { e.type = (el.type || 'text').toLowerCase(); if (e.type !== 'password' && el.value && e.role === 'textbox') e.value = clip(el.value, 80); }
    if (el.tagName === 'TEXTAREA' && el.value) e.value = clip(el.value, 80);
    return e;
  });
  const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim();
  return { url: location.href, title: document.title, text: text.slice(0, TEXT_LIMIT), truncated: text.length > TEXT_LIMIT, elements, more: Math.max(0, all.length - ELEMENT_LIMIT) };
})()`;

/** The snapshot as text for the model (its tab number first). */
export function formatSnapshot(tab: number, s: PageSnapshot): string {
  const lines = [`Tab ${tab}: ${s.title || '(no title)'}`, `Address: ${s.url}`, '', s.text || '(no text)'];
  if (s.truncated) lines.push(`(text cut at ${TEXT_LIMIT} characters)`);
  lines.push('', s.elements.length ? 'Elements (use the number with the browser tools):' : 'No elements to act on.');
  for (const e of s.elements) {
    const extra = [e.type && e.role === 'textbox' && e.type !== 'text' ? e.type : '', e.value !== undefined ? `value "${e.value}"` : '', e.href ? `→ ${e.href}` : ''].filter(Boolean).join(' ');
    lines.push(`[${e.ref}] ${e.role} "${e.name}"${extra ? ` ${extra}` : ''}`);
  }
  if (s.more) lines.push(`(${s.more} more not listed)`);
  return lines.join('\n');
}

/** A snapshot from the page, checked (the page answers through our script, but check the shape anyway). */
export function asSnapshot(v: unknown): PageSnapshot | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.url !== 'string' || typeof o.text !== 'string' || !Array.isArray(o.elements)) return null;
  const elements = o.elements
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
    .map((e) => ({
      ref: Number(e.ref),
      role: String(e.role ?? ''),
      name: String(e.name ?? ''),
      ...(typeof e.href === 'string' ? { href: e.href } : {}),
      ...(typeof e.value === 'string' ? { value: e.value } : {}),
      ...(typeof e.type === 'string' ? { type: e.type } : {}),
    }))
    .filter((e) => Number.isInteger(e.ref) && e.ref > 0);
  return { url: o.url, title: typeof o.title === 'string' ? o.title : '', text: o.text, truncated: o.truncated === true, elements, more: Number(o.more) || 0 };
}
