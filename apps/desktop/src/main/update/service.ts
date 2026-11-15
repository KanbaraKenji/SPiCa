// Self-update and announcements from one source: a shared folder or an
// http(s) address holding what `npm run dist` produced.
//
// electron-updater's generic provider only speaks HTTP, and companies often
// hand out builds on a shared drive, so this reads electron-builder's own
// latest.yml from either kind of source, checks the installer's sha512, and
// runs the per-user NSIS installer silently (no administrator rights).
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { firstWorking } from './pick-source';
import { compareVersions, parseChannel, parseLatestYml, parseNotices, type ChannelInfo, type Notice, type UpdateState } from '../../shared/updates';

export type FetchLike = (url: string) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  /** A real fetch's body, read in pieces so the download can say how far it is. */
  body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } } | null;
  headers?: { get(name: string): string | null };
}>;

export interface UpdateServiceOptions {
  currentVersion: string;
  /** Running from an installed (packaged) build. */
  packaged: boolean;
  /** Portable exe: it cannot replace itself. */
  portable: boolean;
  /** Where downloaded installers are kept. */
  downloadsDir: string;
  /** The configured source and whether it came from the build (deploy.json or the official channel), not the user. */
  getSource(): { source: string; fromDeploy: boolean; sources?: string[] };
  /** The build's source said it moved (channel.json "movedTo"): remember it; getSource gives the new one from now on. */
  onMoved?(from: string, to: string): void;
  fetch: FetchLike;
  /** Starts the installer and quits the app. */
  launchInstaller(path: string): void;
  /** Where the raw error goes (the user sees updateErrorText's words). */
  log?(line: string): void;
}

/** Which step of an update check went wrong, for the words the user sees. */
export type UpdateStep = 'connect' | 'download' | 'write';

/**
 * A failed update in words a user can act on (what went wrong, then what to do), as the app's other errors are said;
 * the raw error goes to the log. A disk that cannot take the file is said as such, whatever the step.
 */
export function updateErrorText(step: UpdateStep, err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code ?? '';
  if (/^(ENOSPC|EACCES|EPERM|EBUSY|EROFS|EIO)$/.test(code)) return '新版本无法保存到这台电脑，请检查磁盘空间后重试。';
  if (step === 'write') return '新版本无法保存到这台电脑，请检查磁盘空间后重试。';
  if (step === 'download') return '新版本下载中断，请检查网络后重试。';
  return '无法连接更新服务器，请检查网络后重试。';
}

/** Words for the cases that are not thrown errors. */
export const UPDATE_WORDS = {
  noVersion: '更新服务器上没有版本信息，请稍后重试。',
  badFile: '新版本文件校验不对，未安装，请稍后重试。',
  portable: (v: string) => `有新版本 ${v}。便携版不能自动更新，请换用新版的便携版。`,
} as const;

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

  /** Of a source with several addresses, the one the last check could read (the others are not used until it fails). */
  #chosen: string | undefined;

  /** The address in use: the one chosen among several, else the source. */
  #current(): string {
    const { source, sources } = this.#o.getSource();
    return this.#chosen && sources?.includes(this.#chosen) ? this.#chosen : source;
  }

  /**
   * A source with several addresses: the first (in pick-source.ts's order) whose latest.yml can be read. None can:
   * the first, so what is said is about the one meant first.
   */
  async #pick(): Promise<string> {
    const { source, sources } = this.#o.getSource();
    if (!sources || sources.length < 2) {
      this.#chosen = undefined;
      return source;
    }
    try {
      const { place } = await firstWorking(sources, async (p) => {
        if (!(await this.#text(p, 'latest.yml'))) throw new Error('no latest.yml');
        return true;
      });
      this.#chosen = place;
    } catch {
      this.#chosen = undefined;
    }
    return this.#current();
  }

  #set(patch: Partial<UpdateState>): void {
    const { fromDeploy } = this.#o.getSource();
    this.#state = { ...this.#state, ...patch, source: this.#current(), sourceFromDeploy: fromDeploy };
    if (!('message' in patch)) delete this.#state.message;
    for (const l of this.#listeners) l(this.state);
  }

  async #text(source: string, name: string): Promise<string | undefined> {
    if (isUrl(source)) {
      const res = await this.#o.fetch(urlFor(source, name));
      if (res.status === 404) return undefined;
      if (!res.ok) throw new Error(`the update server answered ${res.status}`);
      return res.text();
    }
    try {
      return await readFile(join(source, name), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  /** Downloads (or copies) the installer, saying how far it is (state.progress) a few times a second at most. */
  async #bytesTo(source: string, name: string, dest: string): Promise<void> {
    let last = 0;
    const say = (done: number, total: number) => {
      const now = Date.now();
      if (!total || (now - last < 250 && done < total)) return;
      last = now;
      this.#set({ progress: Math.min(1, done / total), ...(this.#state.message ? { message: this.#state.message } : {}) });
    };
    if (isUrl(name) || isUrl(source)) {
      const res = await this.#o.fetch(isUrl(name) ? name : urlFor(source, name));
      if (!res.ok) throw new Error(`the download answered ${res.status}`);
      const total = Number(res.headers?.get('content-length') ?? 0) || 0;
      const reader = res.body?.getReader();
      if (!reader) {
        await writeFile(dest, Buffer.from(await res.arrayBuffer()));
        return;
      }
      const parts: Uint8Array[] = [];
      let done = 0;
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        if (r.value) {
          parts.push(r.value);
          done += r.value.length;
          say(done, total);
        }
      }
      await writeFile(dest, Buffer.concat(parts));
    } else {
      const from = join(source, name);
      const total = (await stat(from)).size;
      let done = 0;
      await new Promise<void>((resolve, reject) => {
        const rs = createReadStream(from);
        const ws = createWriteStream(dest);
        rs.on('data', (b) => {
          done += b.length;
          say(done, total);
        });
        rs.on('error', reject);
        ws.on('error', reject);
        ws.on('finish', () => resolve());
        rs.pipe(ws);
      });
    }
  }

  /** Looks for a newer version; downloads it when this copy can install it. */
  async check(): Promise<UpdateState> {
    let { source, fromDeploy } = this.#o.getSource();
    if (!source) {
      this.#set({ status: 'off', message: '这个版本不检查更新。' });
      return this.state;
    }
    if (this.#busy) return this.state;
    this.#busy = true;
    let step: UpdateStep = 'connect';
    try {
      source = await this.#pick();
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
        if (required !== Boolean(this.#state.required)) this.#set({ required, ...(this.#state.message ? { message: this.#state.message } : {}) });
        return this.state;
      }
      this.#set({ status: 'checking' });
      const yml = await this.#text(source, 'latest.yml');
      const latest = yml ? parseLatestYml(yml) : undefined;
      if (!latest) {
        this.#set({ status: 'error', message: UPDATE_WORDS.noVersion });
        return this.state;
      }
      if (compareVersions(latest.version, this.#o.currentVersion) <= 0) {
        this.#set({ status: 'latest', required: false, message: `已是最新版本（${this.#o.currentVersion}）。` });
        return this.state;
      }
      if (this.#o.portable || !this.#o.packaged) {
        this.#set({
          status: 'manual',
          available: latest.version,
          required,
          message: this.#o.portable ? UPDATE_WORDS.portable(latest.version) : `有新版本 ${latest.version}（开发版不自动安装）。`,
        });
        return this.state;
      }
      this.#set({ status: 'downloading', available: latest.version, required, message: `正在下载 ${latest.version}…` });
      step = 'write';
      await mkdir(this.#o.downloadsDir, { recursive: true });
      const dest = join(this.#o.downloadsDir, fileName(latest.path));
      step = 'download';
      await this.#bytesTo(source, latest.path, dest);
      const got = createHash('sha512').update(await readFile(dest)).digest('base64');
      if (got !== latest.sha512) {
        this.#set({ status: 'error', message: UPDATE_WORDS.badFile });
        return this.state;
      }
      this.#ready = dest;
      this.#set({ status: 'ready', available: latest.version, required, progress: undefined, message: `新版本 ${latest.version} 已下载，重启后更新。` });
      // Found at start and it must update: installed now, without asking.
      if (this.#forcing) this.install();
      return this.state;
    } catch (err) {
      this.#o.log?.(`[spica] update (${step}): ${err instanceof Error ? err.message : String(err)}`);
      this.#set({ status: 'error', progress: undefined, message: updateErrorText(step, err) });
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

  #forcing = false;

  /**
   * A version that must update, found at start: installs as soon as it is downloaded (now, when it already is). A
   * download that fails leaves `forcing` on with the reason, so the window can offer 重试 (check again).
   */
  forceInstall(): void {
    this.#forcing = true;
    this.#set({ forcing: true, ...(this.#state.message ? { message: this.#state.message } : {}) });
    if (this.#ready) this.install();
  }

  /** Runs the downloaded installer silently and quits; it starts the new version when done. */
  install(): boolean {
    if (!this.#ready) return false;
    this.#o.launchInstaller(this.#ready);
    return true;
  }

  /** Announcements from the same source; none when the file is missing. */
  async notices(): Promise<Notice[] | undefined> {
    const source = this.#current();
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
    const source = this.#current();
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
    this.#set({ pluginUpdates: n, ...(this.#state.message ? { message: this.#state.message } : {}) });
  }

  /** The source changed in settings: start over. */
  reset(): void {
    this.#ready = undefined;
    const { source } = this.#o.getSource();
    this.#set({ status: source ? 'idle' : 'off', available: undefined, required: false });
  }
}
