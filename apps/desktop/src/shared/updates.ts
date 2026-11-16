// App updates and administrator announcements. Both come from one "update
// source": a shared folder (\\server\share\spica) or an http(s) address that
// holds what `npm run dist` produced (latest.yml + the installer) and, when an
// administrator wants to say something, announcements.json.
import { compareVersions as semverCompare } from '@spica/plugins/version';

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
  /** The source's channel.json says this version must update: the prompt stays, and it installs when idle. */
  required?: boolean;
  /** A version that must update, found at start: it installs as soon as it is downloaded (the window shows it). */
  forcing?: boolean;
  /** While downloading: how far, 0..1 (absent when the size is not known). */
  progress?: number;
  /** Installed plugins with a newer version in their sources, as the last check found. */
  pluginUpdates?: number;
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

/** -1, 0 or 1, as semver orders them (pre-release parts compared one by one, numbers as numbers: rc.10 after rc.9). */
export function compareVersions(a: string, b: string): number {
  const bare = (v: string) => v.trim().replace(/^v/, '');
  return semverCompare(bare(a), bare(b));
}

/** What a source's channel.json says (the publisher edits it by hand; every field may be absent). */
export interface ChannelInfo {
  /** Versions below this one must update. */
  required?: string;
  /** The channel moved: everything it held is read from here from now on (https only). */
  movedTo?: string;
}

const SEMVERISH = /^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/**
 * channel.json: { "required": "0.2.0", "movedTo": "https://…/" }; anything else is ignored, so a wrong file never
 * forces an update or moves the channel.
 */
export function parseChannel(raw: unknown): ChannelInfo {
  const v = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const required = typeof v.required === 'string' && SEMVERISH.test(v.required.trim()) ? v.required.trim().replace(/^v/, '') : undefined;
  const moved = typeof v.movedTo === 'string' ? v.movedTo.trim() : '';
  const movedTo = /^https:\/\//i.test(moved) && URL.canParse(moved) ? (moved.endsWith('/') ? moved : `${moved}/`) : undefined;
  return { ...(required ? { required } : {}), ...(movedTo ? { movedTo } : {}) };
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
  if (!version || !path || !sha512) return undefined;
  // A file next to latest.yml, or (the official channel) the full https address of the release's installer.
  if (/^https:\/\//i.test(path) ? !URL.canParse(path) : /[\\/]|\.\./.test(path)) return undefined;
  return { version, path, sha512 };
}
