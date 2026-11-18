// What an agent's click, typing or key press would do, judged before it is done (the confirmation table of
// ledger-briefs/builtin-browser/方案.md §4, as chosen):
//   - a password, card number or one-time code field: never typed into by the agent — the person does it;
//   - submitting a form (a submit button, Enter in a form's field, type with submit), a download link, and buttons
//     that pay, order, send or delete: asked first, marked 无法撤销 (in either approval mode: a hook's question);
//   - everything else (links, ordinary buttons, typing into an ordinary field): done at once.
// The facts come from the page (an isolated world, browser/snapshot.ts) and are page content: they only decide
// whether to ask, and the card quotes the button's words as the page gives them. The click itself happens in the
// main process right after checking that the element is still the one asked about (`fingerprint`).

import { t } from '../../shared/i18n';

/** What the page says about the element an action would touch. */
export interface ElementFacts {
  found: boolean;
  tag: string;
  /** input type, button type. */
  type: string;
  role: string;
  name: string;
  /** Inside a form: where it goes and how (GET / POST). */
  form?: { action: string; method: string };
  /** A link's address; whether it has the download attribute. */
  href?: string;
  download?: boolean;
  /** autocomplete, name and id, for telling a password / card / code field. */
  autocomplete: string;
  fieldName: string;
  /** Can be typed into. */
  editable: boolean;
  /** The page's address. */
  page: string;
  /** The element's middle in the page's viewport (CSS px), after it was scrolled into view. */
  x: number;
  y: number;
}

export type ActionTool = 'browser_click' | 'browser_type' | 'browser_press' | 'browser_select' | 'browser_hover' | 'browser_drag' | 'browser_file_upload' | 'browser_javascript';

/** The tools judged before they run (their element looked at first, except a key and a script). */
export const ACTION_TOOLS: readonly ActionTool[] = ['browser_click', 'browser_type', 'browser_press', 'browser_select', 'browser_hover', 'browser_drag', 'browser_file_upload', 'browser_javascript'];

export type ActionVerdict = { action: 'allow' } | { action: 'confirm'; reason: string } | { action: 'deny'; reason: string };

/**
 * Runs in the isolated world: the element with that number (browser/snapshot.ts kept the list), scrolled into view.
 * `doc`: the document it was numbered in; another one there now (the page went on), it is not found.
 */
export function inspectScript(ref: number, doc?: string): string {
  return `(() => {
    if (${JSON.stringify(doc ?? '')} && window.__spicaDoc !== ${JSON.stringify(doc ?? '')}) return { found: false, page: location.href };
    const el = (window.__spicaRefs || [])[${Math.floor(ref)} - 1];
    if (!el || !el.isConnected) return { found: false, page: location.href };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    const form = el.form || el.closest('form');
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || (tag === 'button' ? 'submit' : '')).toLowerCase();
    const editable = el.isContentEditable || tag === 'textarea' || (tag === 'input' && !/^(submit|button|reset|image|checkbox|radio|file|hidden|range|color)$/.test(type));
    const name = String(el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('title') || el.getAttribute('placeholder') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    return {
      found: true, tag, type, role: el.getAttribute('role') || '', name,
      ...(form ? { form: { action: form.action || location.href, method: (form.getAttribute('method') || 'get').toLowerCase() } } : {}),
      ...(tag === 'a' ? { href: el.href, download: el.hasAttribute('download') } : {}),
      autocomplete: String(el.getAttribute('autocomplete') || ''), fieldName: String((el.getAttribute('name') || '') + ' ' + (el.id || '')),
      editable, page: location.href, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
    };
  })()`;
}

/** The facts from the page, checked (shape only; the page can lie about everything in them). */
export function asFacts(v: unknown): ElementFacts | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.found !== true) return { found: false, tag: '', type: '', role: '', name: '', autocomplete: '', fieldName: '', editable: false, page: String(o.page ?? ''), x: 0, y: 0 };
  const form = o.form && typeof o.form === 'object' ? (o.form as Record<string, unknown>) : undefined;
  return {
    found: true,
    tag: String(o.tag ?? ''),
    type: String(o.type ?? ''),
    role: String(o.role ?? ''),
    name: String(o.name ?? ''),
    ...(form ? { form: { action: String(form.action ?? ''), method: String(form.method ?? 'get') } } : {}),
    ...(typeof o.href === 'string' ? { href: o.href, download: o.download === true } : {}),
    autocomplete: String(o.autocomplete ?? ''),
    fieldName: String(o.fieldName ?? ''),
    editable: o.editable === true,
    page: String(o.page ?? ''),
    x: Number(o.x) || 0,
    y: Number(o.y) || 0,
  };
}

/** A field the agent never types into: passwords, card numbers, security codes, one-time codes. */
export function sensitiveField(f: ElementFacts): boolean {
  if (f.type === 'password') return true;
  if (/^(cc-|one-time-code|current-password|new-password)/i.test(f.autocomplete)) return true;
  return /pass(word)?|pwd|card.?num|cc.?num|cvv|cvc|security.?code|otp|one.?time|验证码|密码|卡号|安全码/i.test(`${f.fieldName} ${f.name}`);
}

/** Words on a button that do something that cannot be taken back. */
const LASTING = /\b(pay|buy|purchase|order|checkout|place order|send|submit|delete|remove|transfer|confirm|sign up|register|subscribe)\b|付款|支付|购买|下单|结算|发送|提交|删除|移除|转账|确认|注册|订阅|发布/i;

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 60);
  }
}

/** The button's words as the page gives them, quoted and cut short (they are page content). */
function quoted(name: string): string {
  const s = name.trim();
  return t('「{name}」', { name: s.length > 30 ? `${s.slice(0, 30)}…` : s || '—' });
}

/**
 * A card's question on two lines: what, then where and on what (the card shows the second grey under the first,
 * one line, cut with … when long; chat/Blocks.tsx ConfirmCard).
 */
function twoLines(what: string, site: string, on?: string): string {
  return `${what}\n${on ? t('{site} · {on}', { site: shortSite(site), on }) : site}`;
}

/** A long host cut in the middle (its start and its end kept), so what follows it (the button's words) still shows. */
export function shortSite(site: string): string {
  return site.length > 36 ? `${site.slice(0, 16)}…${site.slice(-18)}` : site;
}

/** Whether to do it, ask first, or leave it to the person. The question's words are the confirmation card's. */
export function judge(tool: ActionTool, f: ElementFacts | null, input: { key?: unknown; submit?: unknown; text?: unknown; paths?: unknown } = {}): ActionVerdict {
  // a script in the page: it can do anything the page can (its sign-ins included), so always asked
  if (tool === 'browser_javascript') return { action: 'confirm', reason: twoLines(t('运行脚本'), host(f?.page ?? '')) };
  if (tool === 'browser_press') {
    // Enter in a form's field sends the form
    if (String(input.key ?? '').toLowerCase() === 'enter' && f?.found && f.form) return { action: 'confirm', reason: twoLines(t('提交表单'), host(f.form.action)) };
    return { action: 'allow' };
  }
  if (!f || !f.found) return { action: 'allow' }; // the tool says it is not there
  if (tool === 'browser_hover' || tool === 'browser_drag') return { action: 'allow' };
  if (tool === 'browser_file_upload') {
    const names = (Array.isArray(input.paths) ? input.paths : []).map((p) => String(p).split(/[\\/]/).pop() ?? '').filter(Boolean);
    return { action: 'confirm', reason: twoLines(t('上传文件'), host(f.page), names.map(quoted).join('')) };
  }
  if (tool === 'browser_select') {
    if (sensitiveField(f)) return { action: 'deny', reason: 'card or code field: the person fills this in themselves in the panel; ask them to do it' };
    return { action: 'allow' };
  }
  if (tool === 'browser_type') {
    if (sensitiveField(f)) return { action: 'deny', reason: 'password, card number or one-time code field: the person types this themselves in the panel; ask them to do it' };
    if (input.submit === true) {
      const text = String(input.text ?? '');
      return { action: 'confirm', reason: twoLines(t('填入并提交'), host(f.form?.action ?? f.page), t('{field}：{text}', { field: quoted(f.name), text: quoted(text) })) };
    }
    return { action: 'allow' };
  }
  // a click; a file box is not clicked (it would open the system's file dialog): its files are set
  if (f.tag === 'input' && f.type === 'file') return { action: 'deny', reason: 'that is a file box: set its files with browser_file_upload (its number and the paths) instead of clicking it' };
  const submit = (f.tag === 'button' && f.type === 'submit' && !!f.form) || (f.tag === 'input' && (f.type === 'submit' || f.type === 'image'));
  if (submit) return { action: 'confirm', reason: twoLines(t('提交表单'), host(f.form?.action ?? f.page), quoted(f.name)) };
  if (f.download) return { action: 'confirm', reason: twoLines(t('下载'), host(f.href ?? f.page), quoted(f.name)) };
  if (f.tag !== 'a' && LASTING.test(f.name)) return { action: 'confirm', reason: twoLines(t('点击按钮'), host(f.page), quoted(f.name)) };
  return { action: 'allow' };
}

/** What identifies the element asked about: if it changed before the click, the click is not done. */
export function fingerprint(f: ElementFacts): string {
  return [f.tag, f.type, f.name, f.form?.action ?? '', f.form?.method ?? '', f.href ?? '', host(f.page)].join('|');
}

/** Keys browser_press knows (as CDP wants them). */
export const KEYS: Record<string, { key: string; code: string; keyCode: number }> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  space: { key: ' ', code: 'Space', keyCode: 32 },
};
