// deploy.json "python": a company's switches for the app's own Python (core python-env.ts), read in one place by
// the desktop packaging check (apps/desktop/scripts/deploy.mjs), its uv fetch (scripts/uv.mjs) and the app
// (main/index.ts), as the preset models are (presetProblems).
//
//   "python": { "enabled": true, "pythonMirror": "", "packageIndex": "" }
//
// enabled: false switches the download off (no python_env, no uv in the package). pythonMirror: where Python
// downloads come from instead of releases.astral.sh (uv's UV_PYTHON_INSTALL_MIRROR: an http(s) address or a
// file:// folder laid out as python-build-standalone's releases). packageIndex: the package index instead of PyPI
// (uv's UV_DEFAULT_INDEX: the simple index address). Not written: on, with the public sources (a renamed build
// too). No logins in the addresses: the installer would carry them; a proxy login goes in 设置 › 常规 › 网络.

export interface DeployPython {
  enabled: boolean;
  pythonMirror?: string;
  packageIndex?: string;
}

const KEYS = new Set(['enabled', 'pythonMirror', 'packageIndex']);

/** What is wrong with deploy.json's "python" (Chinese, for the person packaging); none when it is fine or absent. */
export function deployPythonProblems(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== 'object' || Array.isArray(raw)) return ['python 要写成 { "enabled": …, "pythonMirror": …, "packageIndex": … }。'];
  const v = raw as Record<string, unknown>;
  const out: string[] = [];
  for (const k of Object.keys(v)) if (!KEYS.has(k) && !k.startsWith('//')) out.push(`python.${k} 不认识（只有 enabled、pythonMirror、packageIndex）。`);
  if (v.enabled !== undefined && typeof v.enabled !== 'boolean') out.push('python.enabled 要写 true 或 false。');
  for (const k of ['pythonMirror', 'packageIndex'] as const) {
    const s = v[k];
    if (s === undefined || s === '') continue;
    if (typeof s !== 'string') {
      out.push(`python.${k} 要写成地址。`);
      continue;
    }
    let u: URL;
    try {
      u = new URL(s.trim());
    } catch {
      out.push(`python.${k}「${s}」不是地址（写成 https://… 或 file:///…）。`);
      continue;
    }
    if (!/^(https?|file):$/.test(u.protocol)) out.push(`python.${k}「${s}」要以 https://、http:// 或 file:/// 开头。`);
    else if (u.username || u.password) out.push(`python.${k} 里不要写账号密码：安装包会带着它。代理的登录在 设置 › 常规 › 网络。`);
  }
  return out;
}

/** The switches in force (a deploy.json the packaging checked; anything unreadable counts as not written). */
export function deployPython(deploy: unknown): DeployPython {
  const raw = deploy && typeof deploy === 'object' ? (deploy as { python?: unknown }).python : undefined;
  if (!raw || typeof raw !== 'object' || deployPythonProblems(raw).length) return { enabled: true };
  const v = raw as Record<string, unknown>;
  const str = (k: string) => (typeof v[k] === 'string' && (v[k] as string).trim() ? (v[k] as string).trim() : undefined);
  const mirror = str('pythonMirror');
  const index = str('packageIndex');
  return { enabled: v.enabled !== false, ...(mirror ? { pythonMirror: mirror } : {}), ...(index ? { packageIndex: index } : {}) };
}
