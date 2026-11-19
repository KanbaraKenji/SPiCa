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
  /** A drop-down's options (their words, the first 30). */
  options?: string[];
}

export interface PageSnapshot {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
  elements: PageElement[];
  more: number;
  /** Which document this is (numbers start again in a new one). */
  doc?: string;
  /** The frames in the page (iframes), read the same way; their elements numbered with the page's. */
  frames?: FrameSnapshot[];
}

export interface FrameSnapshot {
  url: string;
  text: string;
  truncated: boolean;
  elements: PageElement[];
  more: number;
}

/** Most characters of a frame's text given back in one read. */
export const FRAME_TEXT_LIMIT = 4_000;

/**
 * The page's elements keep their numbers while they stay on the page: the first time an element is listed (or found)
 * it gets the next number in window.__spicaRefs (the isolated world's own window, so per document), later reads give
 * it the same one. So a number read before a click still means the same element after it (a batch of steps).
 * __spicaDoc tells one document from the next (a new page starts its numbers again).
 */
const REFS = `const refs = (window.__spicaRefs = window.__spicaRefs || []); const ids = (window.__spicaIds = window.__spicaIds || new WeakMap()); window.__spicaDoc = window.__spicaDoc || String(Math.random()).slice(2, 12);
  const idOf = (el) => { let n = ids.get(el); if (!n) { refs.push(el); n = refs.length; ids.set(el, n); } return n; };`;

const HELPERS = `const sel = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=menuitem], [role=option], [role=switch], [role=textbox], [role=combobox], [contenteditable=""], [contenteditable=true]';
  const visible = (el) => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05; };
  const clip = (s, n) => { s = String(s || '').replace(/\\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
  const roleOf = (el) => { const r = el.getAttribute('role'); if (r) return r; const t = el.tagName.toLowerCase(); if (t === 'a') return 'link'; if (t === 'button' || t === 'summary') return 'button'; if (t === 'select') return 'select'; if (t === 'textarea') return 'textbox'; if (t === 'input') { const ty = (el.getAttribute('type') || 'text').toLowerCase(); if (ty === 'checkbox' || ty === 'radio') return ty; if (ty === 'file') return 'file'; if (ty === 'submit' || ty === 'button' || ty === 'reset' || ty === 'image') return 'button'; return 'textbox'; } return el.isContentEditable ? 'textbox' : t; };
  const nameOf = (el) => { const l = el.getAttribute('aria-label'); if (l) return l; if (el.labels && el.labels[0]) return el.labels[0].innerText; const t = el.tagName.toLowerCase(); if (t === 'input' && /^(submit|button|reset)$/i.test(el.type)) return el.value; return el.innerText || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('alt') || el.getAttribute('name') || ''; };
  const describe = (el, n) => {
    const e = { ref: n, role: roleOf(el), name: clip(nameOf(el), 80) };
    if (el.tagName === 'A') e.href = clip(el.href, 200);
    if (el.tagName === 'INPUT') { e.type = (el.type || 'text').toLowerCase(); if (e.type !== 'password' && el.value && e.role === 'textbox') e.value = clip(el.value, 80); if (e.type === 'file' && el.files && el.files.length) e.value = clip([...el.files].map((f) => f.name).join(', '), 80); }
    if (el.tagName === 'TEXTAREA' && el.value) e.value = clip(el.value, 80);
    if (el.tagName === 'SELECT') { const o = el.selectedOptions && el.selectedOptions[0]; if (o) e.value = clip(o.text, 80); e.options = [...el.options].slice(0, 30).map((o) => clip(o.text, 40)); }
    return e;
  };
  // a file box is often hidden behind a styled button: listed anyway (it is set with browser_file_upload, not clicked)
  const actable = () => [...document.querySelectorAll(sel)].filter((el) => visible(el) || (el.tagName === 'INPUT' && el.type === 'file'));`;

/**
 * Runs in the page's isolated world (or a frame's): lists the visible elements to act on, numbered as above, and
 * returns the snapshot.
 */
export const SNAPSHOT_SCRIPT = `(() => {
  const TEXT_LIMIT = ${TEXT_LIMIT}, ELEMENT_LIMIT = ${ELEMENT_LIMIT};
  ${REFS}
  ${HELPERS}
  const all = actable();
  const elements = all.slice(0, ELEMENT_LIMIT).map((el) => describe(el, idOf(el)));
  const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim();
  return { url: location.href, title: document.title, text: text.slice(0, TEXT_LIMIT), truncated: text.length > TEXT_LIMIT, elements, more: Math.max(0, all.length - ELEMENT_LIMIT), doc: window.__spicaDoc };
})()`;

/** Most matches browser_find gives back. */
export const FIND_LIMIT = 20;

/**
 * Runs in the page's isolated world (or a frame's): elements whose role, name, value, address or text contain the
 * words (any case), the ones to act on first, then other elements whose own text holds them (headings, labels, cells).
 */
export function findScript(query: string): string {
  return `(() => {
  ${REFS}
  ${HELPERS}
  const q = ${JSON.stringify(query.toLowerCase())};
  const out = [];
  for (const el of actable()) {
    if (out.length >= ${FIND_LIMIT}) break;
    const e = describe(el, 0);
    const hay = [e.role, e.name, e.value || '', e.href || '', el.getAttribute('placeholder') || '', el.getAttribute('title') || '', el.getAttribute('name') || '', el.id || ''].join(' ').toLowerCase();
    if (hay.includes(q)) out.push({ ...e, ref: idOf(el) });
  }
  if (out.length < ${FIND_LIMIT} && document.body) {
    const seen = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n && out.length < ${FIND_LIMIT}; n = walker.nextNode()) {
      if (!String(n.nodeValue || '').toLowerCase().includes(q)) continue;
      const el = n.parentElement;
      if (!el || seen.has(el) || el.closest(sel) || !visible(el) || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(el.tagName)) continue;
      seen.add(el);
      out.push({ ref: idOf(el), role: el.tagName.toLowerCase(), name: clip(el.innerText, 80) });
    }
  }
  return { url: location.href, doc: window.__spicaDoc, elements: out };
})()`;
}

/** The snapshot as text for the model (its tab number first). */
export function formatSnapshot(tab: number, s: PageSnapshot): string {
  const lines = [`Tab ${tab}: ${s.title || '(no title)'}`, `Address: ${s.url}`, '', s.text || '(no text)'];
  if (s.truncated) lines.push(`(text cut at ${TEXT_LIMIT} characters)`);
  lines.push('', s.elements.length ? 'Elements (use the number with the browser tools):' : 'No elements to act on.');
  for (const e of s.elements) lines.push(elementLine(e));
  if (s.more) lines.push(`(${s.more} more not listed)`);
  (s.frames ?? []).forEach((f, i) => {
    lines.push('', `Frame ${i + 1}: ${f.url}`, '', f.text || '(no text)');
    if (f.truncated) lines.push(`(text cut at ${FRAME_TEXT_LIMIT} characters)`);
    for (const e of f.elements) lines.push(elementLine(e));
    if (f.more) lines.push(`(${f.more} more not listed)`);
  });
  return lines.join('\n');
}

/** One element as a line: its number, role, name, and what else says what it is. */
export function elementLine(e: PageElement): string {
  const extra = [
    e.type && e.role === 'textbox' && e.type !== 'text' ? e.type : '',
    e.value !== undefined ? `value "${e.value}"` : '',
    e.options?.length ? `options: ${e.options.map((o) => `"${o}"`).join(', ')}` : '',
    e.href ? `→ ${e.href}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `[${e.ref}] ${e.role} "${e.name}"${extra ? ` ${extra}` : ''}`;
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
      ...(Array.isArray(e.options) ? { options: e.options.map(String) } : {}),
    }))
    .filter((e) => Number.isInteger(e.ref) && e.ref > 0);
  return { url: o.url, title: typeof o.title === 'string' ? o.title : '', text: o.text, truncated: o.truncated === true, elements, more: Number(o.more) || 0, ...(typeof o.doc === 'string' ? { doc: o.doc } : {}) };
}
