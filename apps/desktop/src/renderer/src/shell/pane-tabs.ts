// The right panel's tabs (the preview's place): files and web pages side by side, one shown at a time.
// Pure state; App.tsx keeps it and shell/PaneTabs.tsx draws the row.
import type { PreviewInfo } from '../../../shared/bridge';

/** A file to show: from a conversation (its folder resolves relative paths), or a page drawn from an answer (inline). */
export interface FileRequest {
  sessionId: string | null;
  path: string;
  sheet?: number;
  inline?: PreviewInfo;
  /** When the file was asked for: asked for again (the same file pressed again), it is read again. */
  opened?: number;
}

export type PaneTab = { id: string; kind: 'file'; req: FileRequest } | { id: string; kind: 'web'; url: string; title: string };

export interface PaneTabs {
  tabs: PaneTab[];
  /** The tab shown (null: none). */
  active: string | null;
  /** Whether the panel is open; closed, its tabs stay and the title bar's button opens it again. */
  open: boolean;
  /** For new ids. */
  next: number;
}

export const NO_TABS: PaneTabs = { tabs: [], active: null, open: false, next: 1 };

/** The same file is one tab: its conversation (relative paths depend on it) and path. Inline pages are each their own. */
function sameFile(a: FileRequest, b: FileRequest): boolean {
  return !a.inline && !b.inline && a.path === b.path && a.sessionId === b.sessionId;
}

/** New tabs go right after the one shown. */
function insert(s: PaneTabs, tab: PaneTab): PaneTabs {
  const at = s.tabs.findIndex((x) => x.id === s.active);
  const tabs = at < 0 ? [...s.tabs, tab] : [...s.tabs.slice(0, at + 1), tab, ...s.tabs.slice(at + 1)];
  return { tabs, active: tab.id, open: true, next: s.next + 1 };
}

/** Shows a file: its tab if it has one (with this request, e.g. another sheet), else a new tab. */
export function openFile(s: PaneTabs, req: FileRequest): PaneTabs {
  const have = s.tabs.find((x) => x.kind === 'file' && sameFile(x.req, req));
  if (have) return { ...s, tabs: s.tabs.map((x) => (x.id === have.id ? { ...x, req } : x)), active: have.id, open: true };
  return insert(s, { id: `t${s.next}`, kind: 'file', req });
}

/** Opens a web page in a new tab ('' : an empty one, to type an address in). */
export function openWeb(s: PaneTabs, url: string): PaneTabs {
  return insert(s, { id: `t${s.next}`, kind: 'web', url, title: '' });
}

export function activate(s: PaneTabs, id: string): PaneTabs {
  return s.tabs.some((x) => x.id === id) ? { ...s, active: id, open: true } : s;
}

/** Closes a tab; the one shown goes to its right-hand neighbour (else the left one). The last one closes the panel. */
export function closeTab(s: PaneTabs, id: string): PaneTabs {
  const at = s.tabs.findIndex((x) => x.id === id);
  if (at < 0) return s;
  const tabs = s.tabs.filter((x) => x.id !== id);
  if (!tabs.length) return { ...s, tabs, active: null, open: false };
  const active = s.active === id ? tabs[Math.min(at, tabs.length - 1)]!.id : s.active;
  return { ...s, tabs, active };
}

/** A page went somewhere or got its title (what the tab and the address show). */
export function updateWeb(s: PaneTabs, id: string, patch: { url?: string; title?: string }): PaneTabs {
  return { ...s, tabs: s.tabs.map((x) => (x.id === id && x.kind === 'web' ? { ...x, ...patch } : x)) };
}

/** Changes the request of the file shown (another sheet of a workbook). */
export function updateActiveFile(s: PaneTabs, f: (req: FileRequest) => FileRequest): PaneTabs {
  return { ...s, tabs: s.tabs.map((x) => (x.id === s.active && x.kind === 'file' ? { ...x, req: f(x.req) } : x)) };
}

export function setOpen(s: PaneTabs, open: boolean): PaneTabs {
  return open && !s.tabs.length ? s : { ...s, open };
}

export function activeTab(s: PaneTabs): PaneTab | undefined {
  return s.tabs.find((x) => x.id === s.active);
}

/** A tab's name: the file's name, the page's title, else its address without the scheme. */
export function tabName(tab: PaneTab): string {
  if (tab.kind === 'file') return tab.req.inline?.name ?? tab.req.path.split(/[\\/]/).pop() ?? tab.req.path;
  if (tab.title) return tab.title;
  return tab.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/**
 * What the address box makes of what was typed: a web address as it is; a host or path without a scheme on https.
 * Nothing else (no search engine): '' when it cannot be a web address.
 */
export function addressOf(typed: string): string {
  const s = typed.trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) {
    try {
      return new URL(s).href;
    } catch {
      return '';
    }
  }
  if (/\s/.test(s) || /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s)) return '';
  try {
    const u = new URL(`https://${s}`);
    return u.hostname.includes('.') || u.hostname === 'localhost' || u.hostname.startsWith('[') ? u.href : '';
  } catch {
    return '';
  }
}
