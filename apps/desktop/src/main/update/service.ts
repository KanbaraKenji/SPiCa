// Self-update and announcements from one source: a shared folder or an
// http(s) address holding what `npm run dist` produced.
//
// electron-updater's generic provider only speaks HTTP, and companies often
// hand out builds on a shared drive, so this reads electron-builder's own
// latest.yml from either kind of source, checks the installer's sha512, and
// runs the per-user NSIS installer silently (no administrator rights).
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { t } from '../../shared/i18n';
import { compareVersions, parseChannel, parseLatestYml, parseNotices, type ChannelInfo, type Notice, type UpdateState } from '../../shared/updates';

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>;

export interface UpdateServiceOptions {
  currentVersion: string;
  /** Running from an installed (packaged) build. */
  packaged: boolean;
  /** Portable exe: it cannot replace itself. */
  portable: boolean;
  /** Where downloaded installers are kept. */
  downloadsDir: string;
  /** The configured source and whether it came from the build (deploy.json or the official channel), not the user. */
  getSource(): { source: string; fromDeploy: boolean };
  /** The build's source said it moved (channel.json "movedTo"): remember it; getSource gives the new one from now on. */
  onMoved?(from: string, to: string): void;
  fetch: FetchLike;
  /** Starts the installer and quits the app. */
  launchInstaller(path: string): void;
}

/** A message of the state, said again in the language now each time the state is read. */
type Words = () => string;

/** This service's own failure, in words (not wrapped in 无法连接更新源 again). */
class Said extends Error {
  constructor(readonly words: Words) {
    super(words());
  }
}

const isUrl = (s: string) => /^https?:\/\//i.test(s);

const sameUrl = (a: string, b: string) => a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase();

/** The installer's own name: latest.yml's path, or the last part of its address. */
function fileName(path: string): string {
  if (!isUrl(path)) return path;
  const last = decodeURIComponent(new URL(path).pathname.split('/').pop() ?? '');
  return last && !/[\\/]|\.\./.test(last) ? last : 'installer.exe';
}

function urlFor(base: string, name: string): string {
  return new URL(encodeURIComponent(name), base.endsWith('/') ? base : `${base}/`).toString();
}

export class UpdateService {
  readonly #o: UpdateServiceOptions;
  #state: Omit<UpdateState, 'message'>;
  /** The state's message (made again when read, so it follows 语言). */
  #words: Words | undefined;
  #ready: string | undefined;
  #busy = false;
  #listeners = new Set<(s: UpdateState) => void>();

  constructor(o: UpdateServiceOptions) {
    this.#o = o;
    const { source, fromDeploy } = o.getSource();
    this.#state = { status: source ? 'idle' : 'off', current: o.currentVersion, source, sourceFromDeploy: fromDeploy, portable: o.portable };
  }

  get state(): UpdateState {
    return { ...this.#state, ...(this.#words ? { message: this.#words() } : {}) };
  }

  /** 语言 changed: the listeners get the state in the new language. */
  relabel(): void {
    if (this.#words) for (const l of this.#listeners) l(this.state);
  }

  onChange(listener: (s: UpdateState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** `words`: the new message; none clears it, 'keep' keeps the one there is. */
  #set(patch: Partial<Omit<UpdateState, 'message'>>, words?: Words | 'keep'): void {
    const { source, fromDeploy } = this.#o.getSource();
    this.#state = { ...this.#state, ...patch, source, sourceFromDeploy: fromDeploy };
    if (words !== 'keep') this.#words = words;
    for (const l of this.#listeners) l(this.state);
  }

  async #text(source: string, name: string): Promise<string | undefined> {
    if (isUrl(source)) {
      const res = await this.#o.fetch(urlFor(source, name));
      if (res.status === 404) return undefined;
      if (!res.ok) throw new Said(() => t('更新源返回 {status}', { status: res.status }));
      return res.text();
    }
    try {
      return await readFile(join(source, name), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  async #bytesTo(source: string, name: string, dest: string): Promise<void> {
    if (isUrl(name) || isUrl(source)) {
      const res = await this.#o.fetch(isUrl(name) ? name : urlFor(source, name));
      if (!res.ok) throw new Said(() => t('下载失败（{status}）', { status: res.status }));
      await writeFile(dest, Buffer.from(await res.arrayBuffer()));
    } else {
      await copyFile(join(source, name), dest);
    }
  }

  /** Looks for a newer version; downloads it when this copy can install it. */
  async check(): Promise<UpdateState> {
    let { source, fromDeploy } = this.#o.getSource();
    if (!source) {
      this.#set({ status: 'off' }, () => t('未设置更新源。'));
      return this.state;
    }
    if (this.#busy) return this.state;
    this.#busy = true;
    try {
      let channel = await this.#channel(source);
      // The build's own source moved: follow it once (a source the user typed is theirs and stays).
      if (channel.movedTo && fromDeploy && this.#o.onMoved && !sameUrl(channel.movedTo, source)) {
        this.#o.onMoved(source, channel.movedTo);
        ({ source, fromDeploy } = this.#o.getSource());
        channel = await this.#channel(source);
      }
      const required = channel.required ? compareVersions(this.#o.currentVersion, channel.required) < 0 : false;
      // Downloaded and waiting: only whether it must be installed may have changed (the mark can be taken back).
      if (this.#ready) {
        if (required !== Boolean(this.#state.required)) this.#set({ required }, 'keep');
        return this.state;
      }
      this.#set({ status: 'checking' });
      const yml = await this.#text(source, 'latest.yml');
      const latest = yml ? parseLatestYml(yml) : undefined;
      if (!latest) {
        this.#set({ status: 'error' }, () => t('更新源中缺少版本信息（latest.yml）。'));
        return this.state;
      }
      if (compareVersions(latest.version, this.#o.currentVersion) <= 0) {
        this.#set({ status: 'latest', required: false }, () => t('已是最新版本（{version}）。', { version: this.#o.currentVersion }));
        return this.state;
      }
      const version = latest.version;
      if (this.#o.portable || !this.#o.packaged) {
        this.#set({ status: 'manual', available: version, required }, () =>
          this.#o.portable ? t('有新版本 {version}。便携版不支持自动更新，请从更新源下载。', { version }) : t('有新版本 {version}（开发版不自动安装）。', { version }),
        );
        return this.state;
      }
      this.#set({ status: 'downloading', available: version, required }, () => t('正在下载 {version}…', { version }));
      await mkdir(this.#o.downloadsDir, { recursive: true });
      const dest = join(this.#o.downloadsDir, fileName(latest.path));
      await this.#bytesTo(source, latest.path, dest);
      const got = createHash('sha512').update(await readFile(dest)).digest('base64');
      if (got !== latest.sha512) {
        this.#set({ status: 'error' }, () => t('安装包校验失败，未安装。'));
        return this.state;
      }
      this.#ready = dest;
      this.#set({ status: 'ready', available: version, required }, () => t('新版本 {version} 已下载，重启后更新。', { version }));
      return this.state;
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      // This service's own words, or words from elsewhere already in Chinese, as they are; else what failed.
      const chinese = /[一-鿿]/.test(msg);
      this.#set({ status: 'error' }, err instanceof Said ? err.words : chinese ? () => msg : () => t('无法连接更新源：{msg}', { msg }));
      return this.state;
    } finally {
      this.#busy = false;
    }
  }

  /**
   * The source's channel.json (whether this version must update, whether the channel moved). Missing, unreadable or
   * wrong: no mark at all (nothing forced, nothing moved), and the update check goes on as usual.
   */
  async #channel(source: string): Promise<ChannelInfo> {
    try {
      const text = await this.#text(source, 'channel.json');
      return text ? parseChannel(JSON.parse(text)) : {};
    } catch {
      return {};
    }
  }

  /** Runs the downloaded installer silently and quits; it starts the new version when done. */
  install(): boolean {
    if (!this.#ready) return false;
    this.#o.launchInstaller(this.#ready);
    return true;
  }

  /** Announcements from the same source; none when the file is missing. */
  async notices(): Promise<Notice[] | undefined> {
    const { source } = this.#o.getSource();
    if (!source) return [];
    try {
      const text = await this.#text(source, 'announcements.json');
      return text ? parseNotices(JSON.parse(text)) : [];
    } catch {
      // Keep what we had; try again later.
      return undefined;
    }
  }

  /** A newer model catalog from the same source (model-catalog.json); null when there is none, undefined when it could not be read. */
  async modelCatalog(): Promise<unknown | null | undefined> {
    const { source } = this.#o.getSource();
    if (!source) return null;
    try {
      const text = await this.#text(source, 'model-catalog.json');
      return text ? (JSON.parse(text) as unknown) : null;
    } catch {
      return undefined;
    }
  }

  /** The scheduled plugin check's count (shown with the app's own update, in the same words). */
  setPluginUpdates(n: number): void {
    if ((this.#state.pluginUpdates ?? 0) === n) return;
    this.#set({ pluginUpdates: n }, 'keep');
  }

  /** The source changed in settings: start over. */
  reset(): void {
    this.#ready = undefined;
    const { source } = this.#o.getSource();
    this.#set({ status: source ? 'idle' : 'off', available: undefined, required: false });
  }
}
