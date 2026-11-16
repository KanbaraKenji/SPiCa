// python_env: the Agent asks for the app's own Python and the packages a task needs (python-env.ts). Before
// anything is downloaded the user confirms a card that says what, from where and how big (previewInstall; asked in
// auto mode too). When everything asked for is there already, it runs without asking and says how to call Python.
import { envPython, installFailure, installPython, packageSpecProblem, planPackages, pythonDownload, pythonEnvStatus, PYPI_SIMPLE, UvError, type PythonEnvOptions, type PythonPackage } from '../python-env.ts';
import type { InstallFailure, InstallPreview } from '../types.ts';
import type { Tool } from './types.ts';

export interface PythonToolOptions extends PythonEnvOptions {
  /** After an install (the runtimes the model is told about change). */
  onInstalled?(packages: PythonPackage[]): void;
  /** The app's language (zh-CN, zh-TW, en), for the failure line the Agent passes on. Default zh-CN. */
  locale?(): string | undefined;
}

/**
 * The one line a failed download shows, in the three languages the app speaks. The window shows the same words
 * (its catalogs; a desktop test keeps the two equal). Short, as the run notices are: what failed, where.
 */
export const INSTALL_FAILURE_WORDS: Record<InstallFailure['reason'], { 'zh-CN': string; 'zh-TW': string; en: string }> = {
  connect: { 'zh-CN': '无法连接 {host}', 'zh-TW': '無法連線 {host}', en: 'Couldn’t connect to {host}' },
  certificate: { 'zh-CN': '{host} 的证书不受信任', 'zh-TW': '{host} 的憑證不受信任', en: 'The certificate of {host} isn’t trusted' },
  proxy: { 'zh-CN': '无法连接代理', 'zh-TW': '無法連線 Proxy 伺服器', en: 'Couldn’t connect to the proxy' },
  proxy_auth: { 'zh-CN': '代理需要身份验证（HTTP 407）', 'zh-TW': 'Proxy 伺服器需要驗證（HTTP 407）', en: 'The proxy requires authentication (HTTP 407)' },
  disk: { 'zh-CN': '磁盘空间不足', 'zh-TW': '磁碟空間不足', en: 'Not enough disk space' },
  other: { 'zh-CN': '下载失败', 'zh-TW': '下載失敗', en: 'Download failed' },
};

/** The line for a failure in a language (zh-TW, en; anything else: zh-CN); a host left out reads as the generic line. */
export function installFailureWords(f: InstallFailure, locale?: string): string {
  const lang = locale === 'zh-TW' || locale === 'en' ? locale : 'zh-CN';
  const reason = f.host || !/\{host\}/.test(INSTALL_FAILURE_WORDS[f.reason][lang]) ? f.reason : 'other';
  return INSTALL_FAILURE_WORDS[reason][lang].replace('{host}', f.host ?? '');
}

function packagesOf(input: Record<string, unknown>): string[] {
  const p = input.packages;
  return Array.isArray(p) ? p.map((x) => String(x).trim()).filter(Boolean) : [];
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** What an install would download; undefined when the Python is there and so is every package asked for. */
export async function previewPythonInstall(opts: PythonEnvOptions, packages: string[], signal?: AbortSignal): Promise<InstallPreview | undefined> {
  const ready = pythonEnvStatus(opts.root).ready;
  const planned = await planPackages(opts, packages, signal);
  if (ready && planned.length === 0) return undefined;
  const preview: InstallPreview = { packages: planned, packageHost: hostOf(opts.packageIndex ?? PYPI_SIMPLE) };
  if (!ready) {
    const py = await pythonDownload(opts, signal).catch(() => undefined);
    preview.python = py
      ? { version: py.version, host: hostOf(py.url), ...(py.bytes ? { bytes: py.bytes } : {}) }
      : { version: opts.pythonVersion ?? '3.12', host: opts.pythonMirror ? hostOf(opts.pythonMirror) : 'releases.astral.sh' };
  }
  return preview;
}

export function createPythonTool(opts: PythonToolOptions): Tool {
  return {
    category: 'command',
    spec: {
      name: 'python_env',
      description:
        "Get the app's own Python (a standalone Python the app manages, separate from any Python on this computer) and install packages " +
        'into it, e.g. pandas or openpyxl. The user confirms each download first. Returns the python executable to run scripts with in ' +
        'run_command. For a computer without Python of its own: when this computer has Python, use that one. Packages are plain ' +
        'names with optional version conditions (pandas, numpy>=2).',
      inputSchema: {
        type: 'object',
        properties: {
          packages: { type: 'array', items: { type: 'string' }, description: 'Packages to install (none: only make sure Python is there).' },
        },
      },
    },
    async previewInstall(input) {
      const packages = packagesOf(input);
      // a request that would be refused asks nothing: execute says why
      if (packages.some((p) => packageSpecProblem(p))) return undefined;
      return previewPythonInstall(opts, packages);
    },
    async execute(input, ctx) {
      const packages = packagesOf(input);
      const bad = packages.map(packageSpecProblem).find(Boolean);
      if (bad) return { content: `${bad}. Give package names with optional version conditions only.`, isError: true };
      try {
        const installed = await installPython(opts, packages, { signal: ctx.signal });
        opts.onInstalled?.(installed);
        const st = pythonEnvStatus(opts.root);
        const list = installed.length ? installed.map((p) => `${p.name} ${p.version}`).join(', ') : 'none';
        return {
          content:
            `The app's Python${st.version ? ` ${st.version}` : ''} is ready: ${envPython(opts.root)}\n` +
            `Packages in it: ${list}.\n` +
            `Run scripts with it in run_command, e.g. & "${envPython(opts.root)}" script.py (it has no pip: add packages with python_env).`,
        };
      } catch (e) {
        // stopped by the user while it ran: no line on the card (it says 已中断 already)
        if (ctx.signal.aborted) return { content: "Stopped before the app's Python was set up.", isError: true };
        const err = e instanceof UvError ? e : new UvError(String(e instanceof Error ? e.message : e), '');
        const failure = installFailure(err, opts);
        ctx.emit({ type: 'install.failed', callId: ctx.callId ?? '', failure });
        // the line the card shows, in the app's language, so the Agent says the same thing
        return { content: `${installFailureWords(failure, opts.locale?.())} (uv: ${failure.detail})`, isError: true };
      }
    },
  };
}
