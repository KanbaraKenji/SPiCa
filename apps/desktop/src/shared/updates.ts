// App updates and administrator announcements. Both come from one "update
// source": a shared folder (\\server\share\spica) or an http(s) address that
// holds what `npm run dist` produced (latest.yml + the installer) and, when an
// administrator wants to say something, announcements.json.

export type UpdateStatus = 'off' | 'idle' | 'checking' | 'latest' | 'downloading' | 'ready' | 'manual' | 'error';

export interface UpdateState {
  status: UpdateStatus;
  current: string;
  /** Newer version found at the source. */
  available?: string;
  /** Plain-language line for the settings page. */
  message?: string;
  /** Where updates come from, as configured (empty = not set). */
  source: string;
  /** The source came from the installer's deploy.json, not from the user. */
  sourceFromDeploy: boolean;
  /** Portable copy: cannot replace itself; the user downloads the new one. */
  portable: boolean;
}

export interface Notice {
  id: string;
  text: string;
  level: 'info' | 'warning';
  /** Optional "查看" link (http/https only). */
  link?: string;
  /** Shown from / until (ISO dates); absent = always. */
  start?: string;
  end?: string;
}

/** What announcements.json looks like. */
export interface NoticeFile {
  announcements: Notice[];
}

/** Keeps only well-formed notices; never throws. */
export function parseNotices(raw: unknown): Notice[] {
  const list = raw && typeof raw === 'object' && Array.isArray((raw as NoticeFile).announcements) ? (raw as NoticeFile).announcements : [];
  const out: Notice[] = [];
  for (const n of list) {
    if (!n || typeof n !== 'object') continue;
    const v = n as unknown as Record<string, unknown>;
    if (typeof v.id !== 'string' || !v.id || typeof v.text !== 'string' || !v.text.trim()) continue;
    out.push({
      id: v.id.slice(0, 100),
      text: v.text.trim().slice(0, 300),
      level: v.level === 'warning' ? 'warning' : 'info',
      ...(typeof v.link === 'string' && /^https?:\/\//i.test(v.link) ? { link: v.link } : {}),
      ...(typeof v.start === 'string' ? { start: v.start } : {}),
      ...(typeof v.end === 'string' ? { end: v.end } : {}),
    });
  }
  return out;
}

/** Notices to show now: in their time window and not closed by the user, newest first. */
export function activeNotices(all: readonly Notice[], dismissed: readonly string[], now: Date = new Date()): Notice[] {
  const t = now.getTime();
  return all.filter((n) => {
    if (dismissed.includes(n.id)) return false;
    const s = n.start ? Date.parse(n.start) : Number.NaN;
    const e = n.end ? Date.parse(n.end) : Number.NaN;
    if (!Number.isNaN(s) && t < s) return false;
    if (!Number.isNaN(e) && t > e) return false;
    return true;
  });
}

/** -1, 0 or 1; plain x.y.z (pre-release tags sort before the release). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre = ''] = v.trim().replace(/^v/, '').split('-', 2);
    return { nums: core.split('.').map((x) => Number.parseInt(x, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre > y.pre ? 1 : -1;
}

/** The fields the updater needs from electron-builder's latest.yml. */
export interface LatestInfo {
  version: string;
  path: string;
  sha512: string;
}

/** Reads the top-level version / path / sha512 lines of latest.yml. */
export function parseLatestYml(text: string): LatestInfo | undefined {
  const get = (key: string) => {
    const m = new RegExp(`^${key}:\\s*['"]?([^'"\\r\\n]+?)['"]?\\s*$`, 'm').exec(text);
    return m?.[1];
  };
  const version = get('version');
  const path = get('path');
  const sha512 = get('sha512');
  if (!version || !path || !sha512 || /[\\/]|\.\./.test(path)) return undefined;
  return { version, path, sha512 };
}
