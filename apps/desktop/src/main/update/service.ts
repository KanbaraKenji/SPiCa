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
import { compareVersions, parseLatestYml, parseNotices, type Notice, type UpdateState } from '../../shared/updates';

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>;

export interface UpdateServiceOptions {
  currentVersion: string;
  /** Running from an installed (packaged) build. */
  packaged: boolean;
  /** Portable exe: it cannot replace itself. */
  portable: boolean;
  /** Where downloaded installers are kept. */
  downloadsDir: string;
  /** The configured source and whether it came from deploy.json. */
  getSource(): { source: string; fromDeploy: boolean };
  fetch: FetchLike;
  /** Starts the installer and quits the app. */
  launchInstaller(path: string): void;
}

const isUrl = (s: string) => /^https?:\/\//i.test(s);

function urlFor(base: string, name: string): string {
  return new URL(encodeURIComponent(name), base.endsWith('/') ? base : `${base}/`).toString();
}

export class UpdateService {
  readonly #o: UpdateServiceOptions;
  #state: UpdateState;
  #ready: string | undefined;
  #busy = false;
  #listeners = new Set<(s: UpdateState) => void>();

  constructor(o: UpdateServiceOptions) {
    this.#o = o;
    const { source, fromDeploy } = o.getSource();
    this.#state = { status: source ? 'idle' : 'off', current: o.currentVersion, source, sourceFromDeploy: fromDeploy, portable: o.portable };
  }

  get state(): UpdateState {
    return { ...this.#state };
  }

  onChange(listener: (s: UpdateState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #set(patch: Partial<UpdateState>): void {
    const { source, fromDeploy } = this.#o.getSource();
    this.#state = { ...this.#state, ...patch, source, sourceFromDeploy: fromDeploy };
    if (!('message' in patch)) delete this.#state.message;
    for (const l of this.#listeners) l(this.state);
  }

  async #text(source: string, name: string): Promise<string | undefined> {
    if (isUrl(source)) {
      const res = await this.#o.fetch(urlFor(source, name));
      if (res.status === 404) return undefined;
      if (!res.ok) throw new Error(`更新源返回 ${res.status}`);
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
    if (isUrl(source)) {
      const res = await this.#o.fetch(urlFor(source, name));
      if (!res.ok) throw new Error(`下载失败（${res.status}）`);
      await writeFile(dest, Buffer.from(await res.arrayBuffer()));
    } else {
      await copyFile(join(source, name), dest);
    }
  }

  /** Looks for a newer version; downloads it when this copy can install it. */
  async check(): Promise<UpdateState> {
    const { source } = this.#o.getSource();
    if (!source) {
      this.#set({ status: 'off', message: '还没有设置更新源。' });
      return this.state;
    }
    if (this.#busy) return this.state;
    if (this.#ready) return this.state;
    this.#busy = true;
    try {
      this.#set({ status: 'checking' });
      const yml = await this.#text(source, 'latest.yml');
      const latest = yml ? parseLatestYml(yml) : undefined;
      if (!latest) {
        this.#set({ status: 'error', message: '更新源里没有找到版本信息（latest.yml）。' });
        return this.state;
      }
      if (compareVersions(latest.version, this.#o.currentVersion) <= 0) {
        this.#set({ status: 'latest', message: `已经是最新版本（${this.#o.currentVersion}）。` });
        return this.state;
      }
      if (this.#o.portable || !this.#o.packaged) {
        this.#set({
          status: 'manual',
          available: latest.version,
          message: this.#o.portable ? `有新版本 ${latest.version}。便携版不能自己更新，请从更新源拿新的便携版。` : `有新版本 ${latest.version}（开发版不自动安装）。`,
        });
        return this.state;
      }
      this.#set({ status: 'downloading', available: latest.version, message: `正在下载 ${latest.version}…` });
      await mkdir(this.#o.downloadsDir, { recursive: true });
      const dest = join(this.#o.downloadsDir, latest.path);
      await this.#bytesTo(source, latest.path, dest);
      const got = createHash('sha512').update(await readFile(dest)).digest('base64');
      if (got !== latest.sha512) {
        this.#set({ status: 'error', message: '下载的安装包校验不通过，没有安装。' });
        return this.state;
      }
      this.#ready = dest;
      this.#set({ status: 'ready', available: latest.version, message: `新版本 ${latest.version} 已经下好，重启就会更新。` });
      return this.state;
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      this.#set({ status: 'error', message: /[一-鿿]/.test(msg) ? msg : `连不上更新源：${msg}` });
      return this.state;
    } finally {
      this.#busy = false;
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

  /** The source changed in settings: start over. */
  reset(): void {
    this.#ready = undefined;
    const { source } = this.#o.getSource();
    this.#set({ status: source ? 'idle' : 'off', available: undefined });
  }
}
